import { getDb } from "@appable/db";
import {
  checkBundle,
  execInProject,
  getProjectLogs,
  verifyApp,
} from "../src/orchestrator.ts";

const nameFilter = process.argv[2]?.toLowerCase() ?? "mealmingle";

const db = getDb();
const projects = await db.project.findMany({
  orderBy: { updatedAt: "desc" },
  include: {
    specs: { orderBy: { version: "desc" }, take: 1 },
    checkpoints: { orderBy: { createdAt: "desc" }, take: 5 },
  },
});

const matches = projects.filter(
  (p) =>
    p.name.toLowerCase().includes(nameFilter) ||
    (p.specs[0]?.data?.name && String(p.specs[0].data.name).toLowerCase().includes(nameFilter)),
);

if (matches.length === 0) {
  console.log("No projects matching:", nameFilter);
  console.log(
    "Available:",
    projects.map((p) => ({ id: p.id, name: p.name, status: p.status })),
  );
  process.exit(1);
}

for (const project of matches) {
  console.log("\n===", project.name, "===", project.id);
  console.log({
    status: project.status,
    metroPort: project.metroPort,
    paid: Boolean(project.paidAt),
    checkpoints: project.checkpoints.length,
    specName: project.specs[0]?.data?.name,
    screens: project.specs[0]?.data?.screens?.length,
    updatedAt: project.updatedAt,
  });

  try {
    const git = await execInProject(project.id, ["git", "status", "--porcelain"]);
    const head = await execInProject(project.id, ["git", "rev-parse", "--short", "HEAD"]);
    console.log("git:", {
      head: head.stdout.trim(),
      dirty: Boolean(git.stdout.trim()),
      dirtyFiles: git.stdout.trim().split("\n").filter(Boolean).slice(0, 8),
    });
  } catch (err) {
    console.log("git: container not available —", err.message);
  }

  const verify = await verifyApp(project.id);
  console.log("health:", verify ? `UNHEALTHY — ${verify}` : "OK (bundle compiles + preview loads)");

  if (project.metroPort) {
    const bundleOnly = await checkBundle(project.id);
    if (bundleOnly && bundleOnly !== verify) console.log("bundle detail:", bundleOnly);

    try {
      const res = await fetch(`http://127.0.0.1:${project.metroPort}/status`, {
        signal: AbortSignal.timeout(5000),
      });
      console.log("metro:", res.ok ? "up" : `HTTP ${res.status}`);
      const preview = await fetch(`http://127.0.0.1:${project.metroPort}/`, {
        signal: AbortSignal.timeout(10000),
      });
      console.log("preview page:", preview.ok ? `HTTP ${preview.status}` : `failed ${preview.status}`);
    } catch (e) {
      console.log("metro/preview: unreachable —", e.message);
    }
  }

  const logs = await getProjectLogs(project.id, 50);
  const errors = logs
    .split("\n")
    .filter((l) => /error|failed|unable to resolve|syntax/i.test(l))
    .slice(-8);
  if (errors.length) {
    console.log("recent log issues:");
    for (const e of errors) console.log(" ", e.slice(0, 220));
  }
}

await db.$disconnect();

/**
 * Build-only A/B: same spec, pay, build, verify preview.
 * API must be running with MODEL_BUILD set to the model under test.
 *
 * Usage: npx tsx -r dotenv/config scripts/build-compare.mjs [model-label]
 */
import WebSocket from "ws";
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

const { getDb } = await import("@appable/db");

const API = "http://localhost:4000";
const LABEL = process.argv[2] ?? process.env.MODEL_BUILD ?? "unknown";
const log = (...a) => console.log(`[compare:${LABEL} ${new Date().toISOString().slice(11, 19)}]`, ...a);

const FIXTURE_SPEC = {
  name: "GymStreak",
  tagline: "Stay consistent with your gym habits",
  description:
    "A simple habit tracker for gym workouts. Check off daily habits and track streaks.",
  category: "fitness",
  vibe: { tone: "energetic", primaryColor: "#FF6B00", style: "dark minimal" },
  screens: [
    {
      name: "Home",
      purpose: "See habits and streaks",
      elements: ["habit list", "streak counter", "add button"],
    },
    {
      name: "Add Habit",
      purpose: "Create a new workout habit",
      elements: ["name input", "save button"],
    },
    {
      name: "Habit Detail",
      purpose: "View one habit's history",
      elements: ["calendar", "streak", "edit"],
    },
    {
      name: "Settings",
      purpose: "App preferences",
      elements: ["theme toggle", "legal links"],
    },
  ],
  dataModel: [
    {
      name: "Habit",
      fields: [
        { name: "id", type: "string" },
        { name: "name", type: "string" },
        { name: "completedDays", type: "string[]" },
      ],
    },
  ],
  features: ["daily check-off", "streak tracking", "local storage"],
  nonGoals: ["social", "accounts", "cloud sync"],
};

async function api(path, opts = {}, token) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function waitFor(state, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.waiters.delete(entry);
      reject(new Error(`Timeout: ${label}`));
    }, timeoutMs);
    const entry = {
      predicate,
      resolve: (event) => {
        clearTimeout(timer);
        resolve(event);
      },
    };
    state.waiters.add(entry);
  });
}

async function seedSpec(projectId) {
  const db = getDb();
  await db.spec.create({
    data: { projectId, version: 1, data: FIXTURE_SPEC },
  });
  await db.project.update({
    where: { id: projectId },
    data: { status: "spec_ready", name: FIXTURE_SPEC.name },
  });
}

async function main() {
  const stats = {
    label: LABEL,
    buildMs: null,
    fileWrites: 0,
    healRounds: 0,
    failed: false,
    bundleBytes: 0,
    previewOk: false,
  };

  const email = `compare-${Date.now()}@appable.dev`;
  const { token } = await api("/auth/register", {
    method: "POST",
    body: { email, password: "secret123" },
  });

  const project = await api("/projects", { method: "POST", body: { name: "Compare Build" } }, token);
  await seedSpec(project.id);
  log("project", project.id, "spec seeded");

  const ws = new WebSocket(
    `ws://localhost:4000/ws?projectId=${project.id}&token=${encodeURIComponent(token)}`,
  );
  const state = { waiters: new Set() };
  let buildStartedAt = null;

  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === "build.event") {
      if (/heal round (\d+)/i.test(event.text)) {
        const m = event.text.match(/heal round (\d+)/i);
        stats.healRounds = Math.max(stats.healRounds, Number(m[1]));
      }
      if (event.level === "error") log("  ERROR:", event.text.slice(0, 120));
    } else if (event.type === "file.op" && event.op === "write") {
      stats.fileWrites++;
    } else if (event.type === "agent.status") {
      log(`  agent: ${event.status} - ${event.message}`);
    } else if (event.type === "project.status" && event.status === "building" && !buildStartedAt) {
      buildStartedAt = Date.now();
    }
    for (const w of [...state.waiters]) {
      if (w.predicate(event)) {
        state.waiters.delete(w);
        w.resolve(event);
      }
    }
  });

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  await api(`/projects/${project.id}/pay`, { method: "POST", body: {} }, token);
  log("starting build...");
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "build.start" }));

  const result = await waitFor(
    state,
    (e) => e.type === "agent.status" && (e.status === "done" || e.status === "failed"),
    30 * 60_000,
    "build finish",
  );

  stats.buildMs = Date.now() - (buildStartedAt ?? t0);
  if (result.status === "failed") {
    stats.failed = true;
    console.log(JSON.stringify(stats));
    process.exit(1);
  }

  const detail = await api(`/projects/${project.id}`, {}, token);
  const webUrl = detail.preview?.webUrl;
  if (!webUrl) throw new Error("No preview URL");

  const bundleRes = await fetch(`${webUrl.replace(/\/$/, "")}/index.ts.bundle?platform=web&dev=true`, {
    signal: AbortSignal.timeout(180_000),
  });
  const bundle = await bundleRes.text();
  if (!bundleRes.ok || bundle.length < 8000) throw new Error(`Bad bundle: ${bundleRes.status} ${bundle.length}b`);
  stats.bundleBytes = bundle.length;
  stats.previewOk = true;

  log(`DONE in ${stats.buildMs}ms | files=${stats.fileWrites} | heal=${stats.healRounds} | bundle=${stats.bundleBytes}`);
  console.log("RESULT_JSON=" + JSON.stringify(stats));
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[compare] FAILED:", err.message);
  console.log("RESULT_JSON=" + JSON.stringify({ label: LABEL, failed: true, error: err.message }));
  process.exit(1);
});

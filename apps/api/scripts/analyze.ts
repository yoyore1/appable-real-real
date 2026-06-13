// Build quality + timing analyzer.
//
// Pulls the project container's source tree + build log, then computes:
//   - wall-clock build time (interview-end -> project.status running)
//   - heal rounds (count of metro "heal round N" markers)
//   - audit issues at end-of-build (icon-missing-testid etc.)
//   - testID coverage (% of <Text>/<Pressable> with a testID)
//   - run-time errors surfaced in metro logs
//   - file touch counts (writes by the agent per file)
//   - bundle size
//
// Usage: tsx scripts/analyze.ts <projectId>
import { spawn } from "node:child_process";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env"), debug: false });

const API = process.env.API_BASE ?? "http://localhost:4000";
const projectId = process.argv[2];
if (!projectId) {
  console.error("usage: tsx scripts/analyze.ts <projectId>");
  process.exit(2);
}

const log = (...a: unknown[]) => console.log(`[analyze ${new Date().toISOString().slice(11, 19)}]`, ...a);

let authToken: string | null = null;
async function api(p: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${p}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${p} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

function dockerExec(containerName: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", containerName, "sh", "-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(out);
      else reject(new Error("docker exec " + code + ": " + err));
    });
  });
}

async function findContainer(projectId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["ps", "--format", "{{.Names}}"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("close", () => {
      const name = out.split("\n").find((n) => n.includes(projectId));
      if (!name) return reject(new Error("no container for projectId " + projectId));
      resolve(name.trim());
    });
  });
}

function testIdCoverage(sources: { path: string; content: string }[]) {
  const totals = { text: 0, textWithTestId: 0, pressable: 0, pressableWithTestId: 0 };
  for (const src of sources) {
    const lines = src.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const next = lines[i + 1] ?? "";
      const blob = ln + "\n" + next;
      if (/<\s*Text\b/.test(blob)) {
        totals.text++;
        if (/testID\s*=/.test(blob) || /testID\s*:/.test(blob)) totals.textWithTestId++;
      }
      if (/<\s*(Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)\b/.test(blob)) {
        totals.pressable++;
        if (/testID\s*=/.test(blob) || /testID\s*:/.test(blob)) totals.pressableWithTestId++;
      }
    }
  }
  return totals;
}

function colorLiteralCount(sources: { path: string; content: string }[]): number {
  let hits = 0;
  for (const src of sources) {
    if (!src.content.includes("StyleSheet.create")) continue;
    const matches = src.content.match(/(?:color|backgroundColor|borderColor):\s*["'][^"']*["']/g) ?? [];
    hits += matches.length;
  }
  return hits;
}

function typedExports(sources: { path: string; content: string }[]) {
  const pattern = /export\s+const\s+[A-Z_][A-Z0-9_]*\s*:\s*\{[^}]+\}\s*=/;
  let typed = 0;
  let untyped = 0;
  for (const src of sources) {
    if (pattern.test(src.content)) typed++;
    else if (/export\s+const\s+[A-Z_][A-Z0-9_]*\s*=\s*\{/.test(src.content)) untyped++;
  }
  return { typed, untyped };
}

function fileTouches(buildLog: string): [string, number][] {
  const touches = new Map<string, number>();
  const re = /file\.op[^}]*"op":"write","path":"([^"]+)"/g;
  let m;
  while ((m = re.exec(buildLog)) !== null) {
    touches.set(m[1], (touches.get(m[1]) ?? 0) + 1);
  }
  return [...touches.entries()].sort((a, b) => b[1] - a[1]);
}

function metroHealRounds(buildLog: string): number[] {
  const rounds: number[] = [];
  const re = /heal round (\d+)/g;
  let m;
  while ((m = re.exec(buildLog)) !== null) rounds.push(Number(m[1]));
  return rounds;
}

function runtimeErrors(buildLog: string): [string, number][] {
  const patterns = [
    /ReferenceError: [^\s]+ is not defined/g,
    /SyntaxError: [^\n]+/g,
    /TypeError: Cannot read propert(y|ies) of (undefined|null)[^\n]+/g,
    /Error: Unable to resolve module [^\n]+/g,
    /Web Bundling failed[^\n]+/g,
    /Uncaught Error[^\n]+/g,
  ];
  const hits = new Map<string, number>();
  for (const p of patterns) {
    let m;
    while ((m = p.exec(buildLog)) !== null) {
      hits.set(m[0], (hits.get(m[0]) ?? 0) + 1);
    }
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const t0 = Date.now();
  log("logging in as e2e user");
  const email = process.env.ANALYZE_EMAIL ?? "e2e-1781355546556@appable.dev";
  const password = process.env.ANALYZE_PASSWORD ?? "secret123";
  const auth = await api("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  }).catch(async (e) => {
    // Already registered — try login.
    return api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  });
  authToken = auth.token;
  log("got token");

  log("fetching project", projectId);
  const project = await api(`/projects/${projectId}`);
  const status = project.status;
  const webUrl = project.preview?.webUrl;
  log("status:", status, "webUrl:", webUrl ?? "(none)");

  const container = await findContainer(projectId);
  log("container:", container);

  log("pulling source tree...");
  const tree = await dockerExec(container, "find /app -type f \\( -name '*.tsx' -o -name '*.ts' -o -name '*.js' -o -name '*.jsx' \\) -not -path '*/node_modules/*' -not -path '*/.expo/*' | sort");
  const paths = tree.split("\n").filter(Boolean).map((p) => p.replace(/^\/app\//, ""));
  log("files in tree:", paths.length);

  const sources: { path: string; content: string }[] = [];
  for (const p of paths) {
    try {
      const content = await dockerExec(container, `cat /app/${p.replace(/ /g, "\\ ")}`);
      sources.push({ path: p, content });
    } catch {
      // skip
    }
  }
  log("sources read:", sources.length);

  const buildLog = await dockerExec(container, "cat /app/.metro-cache/*.log 2>/dev/null || echo ''").catch(() => "");
  const events = await api(`/projects/${projectId}/build-log`).catch(() => ({ events: [] }));
  const logText = [buildLog, ...(events.events ?? []).map((e: any) => `[${e.level}/${e.source}] ${e.text}`)].join("\n");

  const coverage = testIdCoverage(sources);
  const colorLiterals = colorLiteralCount(sources);
  const typed = typedExports(sources);
  const touches = fileTouches(logText);
  const rounds = metroHealRounds(logText);
  const errors = runtimeErrors(logText);

  let bundleBytes = 0;
  let bundleStatus = "?";
  if (webUrl) {
    try {
      const url = webUrl.replace(/\/$/, "") + "/index.bundle?platform=web&dev=true";
      const res = await fetch(url);
      bundleStatus = String(res.status);
      const buf = await res.arrayBuffer();
      bundleBytes = buf.byteLength;
    } catch (e) {
      bundleStatus = `err:${(e as Error).message}`;
    }
  }

  const evList: any[] = events.events ?? [];
  const tBuildStart = evList[0]?.createdAt;
  const tBuildEnd = evList.find((e) => e.text?.includes("Build finished"))?.createdAt;
  const buildSeconds = tBuildStart && tBuildEnd ? (new Date(tBuildEnd).getTime() - new Date(tBuildStart).getTime()) / 1000 : null;

  const report = {
    project: { id: projectId, status, webUrl, container },
    wallclock: { totalSeconds: (Date.now() - t0) / 1000 },
    build: {
      seconds: buildSeconds,
      metroHealRounds: rounds,
      maxRound: rounds.length ? Math.max(...rounds) : 0,
    },
    bundle: { status: bundleStatus, bytes: bundleBytes },
    files: { total: sources.length, audited: sources.length },
    codeQuality: {
      testIdCoverage: {
        text: coverage.textWithTestId + "/" + coverage.text + ` (${coverage.text ? ((coverage.textWithTestId / coverage.text) * 100).toFixed(1) : 0}%)`,
        pressable: coverage.pressableWithTestId + "/" + coverage.pressable + ` (${coverage.pressable ? ((coverage.pressableWithTestId / coverage.pressable) * 100).toFixed(1) : 0}%)`,
      },
      rawColorLiterals: colorLiterals,
      typedExports: typed,
      touchedFiles: touches.length,
      mostTouched: touches.slice(0, 5),
    },
    runtime: { errors },
  };
  console.log("\n=== BUILD ANALYSIS ===\n");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});

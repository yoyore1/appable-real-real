// Live tap-edit e2e harness. Connects to a built project's WS, sends a
// [Tap edit] message, waits for the agent to finish, then verifies that
// (a) the source file changed as expected and (b) the bundle still loads.
//
// Usage:  pnpm exec tsx scripts/tap-e2e.mjs <projectId> [--cases <name,...>] [--dry]
//
// Requires: API on $API_URL (default http://localhost:4000), e2e user in DB.

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env"), debug: false });

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const WS_URL = API_URL.replace(/^http/, "ws");

// --- login as most recent e2e user -----------------------------------------
async function login() {
  const { getDb } = await import("@appable/db");
  const db = getDb();
  const u = await db.user.findFirst({
    where: { email: { startsWith: "e2e-" } },
    orderBy: { createdAt: "desc" },
  });
  await db.$disconnect();
  if (!u) throw new Error("no e2e user found");
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: u.email, password: "secret123" }),
  });
  const j = await res.json();
  if (!j.token) throw new Error("login failed: " + JSON.stringify(j));
  const projectId = process.argv[2];
  return { token: j.token, userId: u.id, project: await getProject(u.id, projectId) };
}

async function getProject(userId, projectId) {
  const { getDb } = await import("@appable/db");
  const db = getDb();
  const p = await db.project.findFirst({ where: { id: projectId, userId } });
  await db.$disconnect();
  if (!p) throw new Error(`project ${projectId} not found for user`);
  return p;
}

// --- test cases -------------------------------------------------------------
// Each case is a tuple: [label, [Tap edit] message, file, expectedSubstring]
// TestIDs are real ones observed in the M3 project (cmqceid5g0031tlhkwbjjwtff).
// After the patchTextByExpression fix, text changes work on data-driven text
// (e.g. {UI_STRINGS.tagline} and {habit.name}) by patching the source constant
// or data array instead of the JSX literal.
const CASES = {
  "habit-color": [
    "color pushups habit name",
    `[Tap edit] In the app, find the element with testID "home-habit-habit-pushups-name" and set the text color to #ff5500. Change only this element.`,
    "app/(tabs)/index.tsx",
    "#ff5500",
  ],
  "habit-bg": [
    "background plank habit card",
    `[Tap edit] In the app, find the element with testID "home-habit-habit-plank-row" and set the background color to #222222. Change only this element.`,
    "app/(tabs)/index.tsx",
    "#222222",
  ],
  "screen-bg": [
    "home screen background",
    `[Tap edit] In the app, find the element with testID "home-screen" and set the background color to #0a0a0a. Change only this element.`,
    "app/(tabs)/index.tsx",
    "#0a0a0a",
  ],
  "home-tagline-color": [
    "home tagline color",
    `[Tap edit] In the app, find the element with testID "home-tagline" and set the text color to #00aaff. Change only this element.`,
    "app/(tabs)/index.tsx",
    "#00aaff",
  ],
  "progress-card-bg": [
    "progress card background",
    `[Tap edit] In the app, find the element with testID "home-progress" and set the background color to #1a1a1a. Change only this element.`,
    "app/(tabs)/index.tsx",
    "#1a1a1a",
  ],
  // Data-driven text cases (post-fix).
  "habit-name-text": [
    "rename pushups habit (data-driven text)",
    `[Tap edit] In the app, find the element with testID "home-habit-habit-pushups-name" and set the text to "Daily Pushups". Change only this element.`,
    "src/lib/storage.ts",
    "Daily Pushups",
  ],
  "home-tagline-text": [
    "home tagline (UI_STRINGS data-driven text)",
    `[Tap edit] In the app, find the element with testID "home-tagline" and set the text to "Stay sharp.". Change only this element.`,
    "src/lib/storage.ts",
    "Stay sharp",
  ],
  // QuickPick-specific cases (project cmqcxgby4001btl0ghabxxi7g).
  "qp-hero-title": [
    "hero title from UI_STRINGS (data-driven text)",
    `[Tap edit] In the app, find the element with testID "home-hero-title-text" and set the text to "Name your next big idea". Change only this element.`,
    "app/(tabs)/index.tsx",
    "Name your next big idea",
  ],
  "qp-hero-body": [
    "hero body from UI_STRINGS (data-driven text)",
    `[Tap edit] In the app, find the element with testID "home-hero-body-text" and set the text to "Tell us about it.". Change only this element.`,
    "app/(tabs)/index.tsx",
    "Tell us about it.",
  ],
  "qp-hero-color": [
    "hero color",
    `[Tap edit] In the app, find the element with testID "home-hero-eyebrow" and set the text color to #ff00aa. Change only this element.`,
    "app/(tabs)/index.tsx",
    "#ff00aa",
  ],
  "qp-cta-label": [
    "hero CTA button label (UI_STRINGS)",
    `[Tap edit] In the app, find the element with testID "home-hero-cta" and set the label to "Begin". Change only this element.`,
    "app/(tabs)/index.tsx",
    "Begin",
  ],
};

// --- WS client --------------------------------------------------------------
async function connectWS(projectId, token) {
  const { WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ws?projectId=${projectId}&token=${token}`);
    const events = [];
    ws.on("open", () => resolve({ ws, events }));
    ws.on("error", (e) => reject(e));
    ws.on("close", () => events.push({ type: "_close" }));
    ws.on("message", (raw) => {
      const s = raw.toString("utf8");
      try { events.push(JSON.parse(s)); } catch {}
    });
  });
}

async function sendTapEdit(projectId, token, msg) {
  const { ws, events } = await connectWS(projectId, token);
  const req = { type: "chat.send", conversation: "build", text: msg, attachments: [] };
  ws.send(JSON.stringify(req));

  // wait for chat.done, agent.status/done, or file.op, or agent.status/idle
  const start = Date.now();
  let last = null;
  let lastTypes = new Set();
  while (Date.now() - start < 240_000) {
    if (!events.length) { await wait(500); continue; }
    last = events[events.length - 1];
    lastTypes.add(last.type);
    if (last.type === "_close") break;
    if (last.type === "chat.done" && last.conversation === "build") break;
    if (last.type === "agent.status" && (last.status === "done" || last.status === "failed" || last.status === "idle")) break;
    if (last.type === "error" && last.code !== "busy") break;
    await wait(500);
  }
  ws.close();
  return { events, last, lastTypes };
}

// --- docker exec helpers ----------------------------------------------------
function dockerRead(container, relPath) {
  const r = spawnSync("docker", ["exec", container, "cat", relPath], {
    encoding: "utf8", shell: process.platform === "win32",
  });
  if (r.status !== 0) return null;
  return r.stdout;
}

function dockerBundleCheck(webUrl) {
  // Bundle is served by Metro inside the container; we hit it from the host
  // via the port-forwarded webUrl.
  const url = webUrl.replace(/\/$/, "") + "/node_modules/expo-router/entry.bundle?platform=web&dev=true";
  try {
    const r = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "60", url], {
      encoding: "utf8", shell: process.platform === "win32",
    });
    return (r.stdout || "").trim();
  } catch {
    return "0";
  }
}

// --- main --------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const ci = args.indexOf("--cases");
  const caseNames = ci >= 0 ? args[ci + 1].split(",") : Object.keys(CASES);
  console.log(`[tap-e2e] args=${JSON.stringify(args)} caseNames=${JSON.stringify(caseNames)}`);
  const projectId = args.find((a) => !a.startsWith("--") && !caseNames.includes(a) && a !== args[ci + 1]);
  if (!projectId) {
    console.error("usage: tap-e2e.mjs <projectId> [--cases a,b,c] [--dry]");
    process.exit(2);
  }

  console.log(`[tap-e2e] projectId=${projectId}`);
  const { token, project } = await login();
  const container = `appable-proj-${projectId}`;
  const webUrl = `http://localhost:${project.webPort}`;
  console.log(`[tap-e2e] webUrl=${webUrl} project keys=${Object.keys(project).join(",")}`);

  // baseline read of each target file
  const baselines = {};
  for (const name of caseNames) {
    const [, , file] = CASES[name];
    baselines[name] = dockerRead(container, `/app/${file}`);
  }

  const results = [];
  for (const name of caseNames) {
    const [label, msg, file, expected] = CASES[name];
    console.log(`\n[case ${name}] ${label}`);
    console.log(`  message: ${msg}`);
    if (dry) { results.push({ name, status: "DRY" }); continue; }
    const { events, last, lastTypes } = await sendTapEdit(projectId, token, msg);
    const errs = events.filter((e) => e.type === "error");
    const done = events.filter((e) => e.type === "agent.status" && e.status === "done");
    const fails = events.filter((e) => e.type === "agent.status" && e.status === "error");
    console.log(`  ws: done=${done.length} fails=${fails.length} errs=${errs.length} types=${[...lastTypes].join(",")}`);
    console.log(`  events: ${events.map((e) => e.type === "build.event" ? `${e.type}(${e.level}:${(e.text||"").slice(0,80)})` : `${e.type}${e.status ? "/" + e.status : ""}`).join(" | ")}`);
    if (fails.length) console.log(`  fail msg: ${fails[0].message}`);
    if (errs.length) console.log(`  err: ${errs[0].code} ${errs[0].message}`);

    // allow Metro to finish re-bundling
    await wait(3000);

    const after = dockerRead(container, `/app/${file}`);
    const changed = baselines[name] !== after;
    // Color values may be written in upper or lower case, or as a token alias.
    // Normalize the comparison: check for the hex in any casing.
    const afterLower = after ? after.toLowerCase() : "";
    const expectedLower = expected.toLowerCase();
    const hasExpected =
      afterLower.includes(expectedLower) ||
      (expectedLower.startsWith("#") &&
        afterLower.includes(expectedLower.replace(/^#/, ""))) ||
      (expectedLower.startsWith("#") &&
        afterLower.includes(expectedLower.replace("#", "0x")));
    const bundle = dockerBundleCheck(webUrl);

    const ok = changed && hasExpected && !fails.length && bundle.startsWith("200");
    results.push({
      name,
      changed,
      hasExpected,
      bundle,
      lastEvent: last?.type,
      ok,
    });
    console.log(`  file changed: ${changed}, contains "${expected}": ${hasExpected}, bundle=${bundle}, ok=${ok}`);
  }

  console.log(`\n=== TAP-E2E RESULTS ===`);
  for (const r of results) {
    console.log(JSON.stringify(r));
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[summary] ${passed}/${results.length} cases passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("[fatal]", e); process.exit(2); });

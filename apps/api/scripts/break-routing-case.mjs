/**
 * One break/heal test case. API must already be running with the arm's env.
 *
 * Phases:
 *   setup  — register, build good app, print SETUP_JSON=...
 *   heal   — reset to headRef, break fixture, run fix edit, print RESULT_JSON=...
 *
 * Usage:
 *   npx tsx -r dotenv/config scripts/break-routing-case.mjs setup
 *   npx tsx -r dotenv/config scripts/break-routing-case.mjs heal --fixture easy --arm mixed \
 *     --projectId ID --token JWT --headRef GIT_SHA
 */
import WebSocket from "ws";
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFixture } from "./break-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

const { getDb } = await import("@appable/db");
const { readProjectFile, writeProjectFile, listProjectFiles, ensureRunning, verifyApp, resetToGitRef, getHeadRef } =
  await import("../src/orchestrator.js");

const API = "http://localhost:4000";
const FIXTURE_SPEC = {
  name: "GymStreak",
  tagline: "Stay consistent with your gym habits",
  description: "A simple habit tracker for gym workouts.",
  category: "fitness",
  vibe: { tone: "energetic", primaryColor: "#FF6B00", style: "dark minimal" },
  screens: [
    { name: "Home", purpose: "See habits", elements: ["habit list", "streak"] },
    { name: "Add Habit", purpose: "Add habit", elements: ["name input"] },
    { name: "Habit Detail", purpose: "Detail", elements: ["calendar"] },
    { name: "Settings", purpose: "Settings", elements: ["legal"] },
  ],
  dataModel: [
    { name: "Habit", fields: [{ name: "id", type: "string" }, { name: "name", type: "string" }] },
  ],
  features: ["check-off", "streaks"],
  nonGoals: ["social"],
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const log = (...a) => console.log(`[break ${new Date().toISOString().slice(11, 19)}]`, ...a);

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
  await db.spec.create({ data: { projectId, version: 1, data: FIXTURE_SPEC } });
  await db.project.update({
    where: { id: projectId },
    data: { status: "spec_ready", name: FIXTURE_SPEC.name },
  });
}

async function setupGoodBuild() {
  const email = `break-${Date.now()}@appable.dev`;
  const { token } = await api("/auth/register", {
    method: "POST",
    body: { email, password: "secret123" },
  });
  const project = await api("/projects", { method: "POST", body: { name: "Break Test" } }, token);
  await seedSpec(project.id);

  const ws = new WebSocket(
    `ws://localhost:4000/ws?projectId=${project.id}&token=${encodeURIComponent(token)}`,
  );
  const state = { waiters: new Set() };
  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === "agent.status") log(`  agent: ${event.status}`);
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
  ws.send(JSON.stringify({ type: "build.start" }));
  const result = await waitFor(
    state,
    (e) => e.type === "agent.status" && (e.status === "done" || e.status === "failed"),
    30 * 60_000,
    "build",
  );
  ws.close();
  if (result.status === "failed") throw new Error("Setup build failed");

  await ensureRunning(project.id);
  const headRef = await getHeadRef(project.id);
  const ok = await verifyApp(project.id);
  if (ok) throw new Error(`Setup build not healthy: ${ok}`);

  return { projectId: project.id, token, headRef };
}

async function runHealCase() {
  const fixture = arg("--fixture");
  const arm = arg("--arm") ?? "unknown";
  const projectId = arg("--projectId");
  const token = arg("--token");
  const headRef = arg("--headRef");
  if (!fixture || !projectId || !token || !headRef) {
    throw new Error("heal phase requires --fixture --projectId --token --headRef");
  }

  const stats = {
    arm,
    fixture,
    healMs: null,
    escalated: false,
    failed: false,
    previewOk: false,
    error: null,
  };

  await ensureRunning(projectId);
  await resetToGitRef(projectId, headRef);
  await applyFixture(projectId, fixture, { readProjectFile, writeProjectFile, listProjectFiles });

  // Metro may still serve a cached bundle right after we break files — poll until the error shows.
  let broken = null;
  for (let i = 0; i < 24; i++) {
    broken = await verifyApp(projectId);
    if (broken) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (!broken) {
    stats.failed = true;
    stats.error = "fixture did not break the app";
    console.log("RESULT_JSON=" + JSON.stringify(stats));
    process.exit(1);
  }
  log(`fixture ${fixture} broke app:`, broken.slice(0, 100));

  const ws = new WebSocket(
    `ws://localhost:4000/ws?projectId=${projectId}&token=${encodeURIComponent(token)}`,
  );
  const state = { waiters: new Set() };
  let healStart = null;

  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === "build.event") {
      if (/Mixed routing:/i.test(event.text)) stats.escalated = true;
    } else if (event.type === "agent.status") {
      if (event.status === "fixing" && !healStart) healStart = Date.now();
      log(`  agent: ${event.status} - ${event.message}`);
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

  const t0 = Date.now();
  let editSent = false;
  ws.send(
    JSON.stringify({
      type: "chat.send",
      conversation: "build",
      text: "The app is broken and will not compile or load. Read the errors, fix all affected files, and make the preview work again.",
    }),
  );
  editSent = true;

  const result = await waitFor(
    state,
    (e) => editSent && e.type === "chat.done" && e.conversation === "build",
    20 * 60_000,
    "heal edit",
  );
  stats.healMs = Date.now() - (healStart ?? t0);
  ws.close();

  const rolledBack = /left everything as it was|left your app exactly/i.test(result.text ?? "");
  if (rolledBack) {
    stats.failed = true;
    stats.error = "rolled back";
    console.log("RESULT_JSON=" + JSON.stringify(stats));
    process.exit(1);
  }

  const detail = await api(`/projects/${projectId}`, {}, token);
  const webUrl = detail.preview?.webUrl;
  if (!webUrl) {
    stats.failed = true;
    stats.error = "no preview url";
    console.log("RESULT_JSON=" + JSON.stringify(stats));
    process.exit(1);
  }

  const bundleRes = await fetch(`${webUrl.replace(/\/$/, "")}/index.ts.bundle?platform=web&dev=true`, {
    signal: AbortSignal.timeout(120_000),
  });
  const bundle = await bundleRes.text();
  stats.previewOk = bundleRes.ok && bundle.length >= 8000;
  stats.failed = !stats.previewOk;
  if (!stats.previewOk) stats.error = `bundle ${bundleRes.status} ${bundle.length}b`;

  log(`heal done ${stats.healMs}ms escalated=${stats.escalated} ok=${stats.previewOk}`);
  console.log("RESULT_JSON=" + JSON.stringify(stats));
  process.exit(stats.failed ? 1 : 0);
}

const phase = process.argv[2];
if (phase === "setup") {
  try {
    const setup = await setupGoodBuild();
    console.log("SETUP_JSON=" + JSON.stringify(setup));
  } catch (err) {
    console.error("[break] setup failed:", err.message);
    process.exit(1);
  }
} else if (phase === "heal") {
  await runHealCase();
} else {
  console.error("Usage: break-routing-case.mjs setup | heal --fixture ... --arm ... --projectId ... --token ... --headRef ...");
  process.exit(1);
}

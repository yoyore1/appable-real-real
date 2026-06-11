/**
 * Interview-only test: timed turns, model check, thinking-leak detection.
 * Uses MODEL_INTERVIEW / MODEL_SUGGESTIONS from .env (Qwen on DeepInfra).
 *
 * Usage: npx tsx -r dotenv/config scripts/interview-test.mjs
 */
import WebSocket from "ws";
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

const { env } = await import("../src/env.js");

const API = "http://localhost:4000";
const log = (...a) => console.log(`[interview-test ${new Date().toISOString().slice(11, 19)}]`, ...a);

const ANSWERS = [
  "I want a simple habit tracker app for gym workouts. It should let me check off my daily workout habits.",
  "It's for regular gym people like me who want to stay consistent with their routines.",
  "You can add a habit like 'bench press' or 'cardio', check it off each day, and see your streak of days in a row.",
  "It should save each habit with its name and which days I completed it, and show my current streak per habit.",
  "Dark theme, energetic vibe, orange as the main color.",
  "Nothing else, keep it simple. No social features.",
  "StreakLift",
];

const THINKING_MARKERS =
  /\[Output|Proceeds\.|thinking process|Self-Correction|Final Check|\[Final Output\]|enable_thinking/i;

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

const turns = [];
let specVersion = 0;
let specName = null;

const email = `interview-${Date.now()}@appable.dev`;
const { token } = await api("/auth/register", {
  method: "POST",
  body: { email, password: "secret123" },
});
const project = await api("/projects", { method: "POST", body: { name: "Interview Test" } }, token);
log("project", project.id);
log("models", { interview: env.modelInterview, suggestions: env.modelSuggestions });

const ws = new WebSocket(
  `ws://localhost:4000/ws?projectId=${project.id}&token=${encodeURIComponent(token)}`,
);
const state = { waiters: new Set() };

ws.on("message", (raw) => {
  const event = JSON.parse(raw.toString());
  if (event.type === "spec.updated") {
    specVersion = event.version;
    specName = event.spec?.name;
    log(`spec v${event.version}: ${event.spec?.name}`);
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

for (let i = 0; i < ANSWERS.length; i++) {
  if (specVersion > 0) break;
  const answer = ANSWERS[i];
  log(`turn ${i + 1} user:`, answer.slice(0, 60) + "...");
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "chat.send", conversation: "interview", text: answer }));

  const done = await waitFor(
    state,
    (e) =>
      (e.type === "chat.done" && e.conversation === "interview") || e.type === "spec.updated",
    180_000,
    `turn ${i + 1}`,
  );

  const ms = Date.now() - t0;
  if (done.type === "chat.done") {
    const leak = THINKING_MARKERS.test(done.text ?? "");
    turns.push({
      turn: i + 1,
      ms,
      model: done.model,
      chars: (done.text ?? "").length,
      thinkingLeak: leak,
      preview: (done.text ?? "").slice(0, 120).replace(/\n/g, " "),
    });
    log(`turn ${i + 1} done ${ms}ms model=${done.model} leak=${leak}`);
    if (leak) log("  LEAK:", (done.text ?? "").slice(0, 200));
  }
  if (specVersion > 0) break;
  await new Promise((r) => setTimeout(r, 300));
}

if (specVersion === 0) {
  log("waiting for spec...");
  await waitFor(state, (e) => e.type === "spec.updated", 180_000, "spec");
}

ws.close();

const totalMs = turns.reduce((s, t) => s + t.ms, 0);
const result = {
  interviewModel: env.modelInterview,
  suggestionsModel: env.modelSuggestions,
  turns: turns.length,
  totalMs,
  avgMs: turns.length ? Math.round(totalMs / turns.length) : 0,
  specReady: specVersion > 0,
  specName,
  thinkingLeaks: turns.filter((t) => t.thinkingLeak).length,
  turnDetails: turns,
};

console.log("\nINTERVIEW_JSON=" + JSON.stringify(result));
process.exit(specVersion > 0 && turns.every((t) => !t.thinkingLeak) ? 0 : 1);

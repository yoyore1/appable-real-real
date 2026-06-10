/**
 * End-to-end engine test:
 * register -> create project -> interview (scripted answers) -> spec ->
 * build -> wait for agent done -> verify web preview responds.
 *
 * Run: pnpm --filter @appable/api exec tsx ../../scripts/e2e.mjs
 */
import WebSocket from "ws";

const API = "http://localhost:4000";
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

const ANSWERS = [
  "I want a simple habit tracker app for gym workouts. It should let me check off my daily workout habits.",
  "It's for regular gym people like me who want to stay consistent with their routines.",
  "You can add a habit like 'bench press' or 'cardio', check it off each day, and see your streak of days in a row.",
  "It should save each habit with its name and which days I completed it, and show my current streak per habit.",
  "Dark theme, energetic vibe, orange as the main color.",
  "Nothing else, keep it simple. No social features.",
];

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

function waitFor(emitterState, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitterState.waiters.delete(entry);
      reject(new Error(`Timeout waiting for: ${label}`));
    }, timeoutMs);
    const entry = {
      predicate,
      resolve: (event) => {
        clearTimeout(timer);
        resolve(event);
      },
    };
    emitterState.waiters.add(entry);
  });
}

async function main() {
  // 1. Auth
  const email = `e2e-${Date.now()}@appable.dev`;
  const { token } = await api("/auth/register", {
    method: "POST",
    body: { email, password: "secret123" },
  });
  log("registered", email);

  // 2. Project
  const project = await api("/projects", { method: "POST", body: { name: "E2E Habit App" } }, token);
  log("project created", project.id);

  // 3. WebSocket
  const ws = new WebSocket(
    `ws://localhost:4000/ws?projectId=${project.id}&token=${encodeURIComponent(token)}`,
  );
  const state = { waiters: new Set() };
  let specVersion = 0;

  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === "chat.delta") return; // too noisy
    if (event.type === "build.event") {
      log(`  [${event.source}/${event.level}]`, event.text.slice(0, 160).replace(/\n/g, " | "));
    } else if (event.type === "agent.status") {
      log(`  agent: ${event.status} - ${event.message}`);
    } else if (event.type === "spec.updated") {
      specVersion = event.version;
      log(`  spec v${event.version}: ${event.spec.name} (${event.spec.screens.length} screens)`);
    } else if (event.type === "preview.status") {
      log(`  preview: ${event.status} ${event.webUrl ?? ""}`);
    } else {
      log(`  event: ${event.type}${event.status ? " " + event.status : ""}`);
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
  log("websocket connected");

  // 4. Interview
  for (const answer of ANSWERS) {
    log("user:", answer.slice(0, 70) + "...");
    ws.send(JSON.stringify({ type: "chat.send", conversation: "interview", text: answer }));
    const done = await waitFor(
      state,
      (e) =>
        (e.type === "chat.done" && e.conversation === "interview") || e.type === "spec.updated",
      180_000,
      "interview reply",
    );
    if (done.type === "spec.updated" || specVersion > 0) break;
    // brief pause between turns
    await new Promise((r) => setTimeout(r, 500));
  }

  if (specVersion === 0) {
    log("waiting for spec extraction...");
    await waitFor(state, (e) => e.type === "spec.updated", 180_000, "spec.updated");
  }
  log("SPEC READY");

  // 5. Build
  log("starting build...");
  ws.send(JSON.stringify({ type: "build.start" }));
  const result = await waitFor(
    state,
    (e) => e.type === "agent.status" && (e.status === "done" || e.status === "failed"),
    30 * 60_000,
    "build finish",
  );
  if (result.status === "failed") throw new Error("Build failed");
  log("BUILD DONE");

  // 6. Verify preview
  const detail = await api(`/projects/${project.id}`, {}, token);
  const webUrl = detail.preview?.webUrl;
  if (!webUrl) throw new Error("No preview URL after build");
  log("preview url:", webUrl, "| expo:", detail.preview.expUrl);

  const res = await fetch(webUrl, { signal: AbortSignal.timeout(30_000) });
  const html = await res.text();
  if (!res.ok) throw new Error(`Preview returned ${res.status}`);
  log(`preview responded ${res.status}, ${html.length} bytes`);

  log("E2E PASSED");
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[e2e] FAILED:", err.message);
  process.exit(1);
});

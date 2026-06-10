/**
 * Edit-mode test against the existing GymStreak project:
 * send an edit request over WS, wait for the chat.done reply, then verify
 * the bundle still compiles.
 *
 * Run: pnpm --filter @appable/api exec tsx scripts/edit-test.mjs
 */
import WebSocket from "ws";

const API = "http://localhost:4000";
const EMAIL = "e2e-1781076664698@appable.dev";
const PASSWORD = "secret123";
const PROJECT_ID = "cmq7r26570019tljkle3livtr";
const REQUEST =
  "Change the app title back to GymStreak and make the accent color orange again";

const log = (...a) => console.log(`[edit ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function main() {
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const { token } = await login.json();
  log("logged in");

  const ws = new WebSocket(
    `ws://localhost:4000/ws?projectId=${PROJECT_ID}&token=${encodeURIComponent(token)}`,
  );
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  log("ws connected, sending edit request...");

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("edit timed out")), 15 * 60_000);
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "agent.status") log(`  agent: ${event.status} - ${event.message}`);
      else if (event.type === "build.event")
        log(`  [${event.source}/${event.level}]`, event.text.slice(0, 140).replace(/\n/g, " | "));
      else if (event.type === "file.op") log(`  file ${event.op}: ${event.path}`);
      else if (event.type === "chat.done" && event.conversation === "build") {
        clearTimeout(timer);
        resolve(event);
      }
    });
    ws.send(JSON.stringify({ type: "chat.send", conversation: "build", text: REQUEST }));
  });

  log("REPLY:", reply.text);

  // Verify the bundle still compiles after the edit
  const detail = await (
    await fetch(`${API}/projects/${PROJECT_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  const port = detail.metroPort;
  const bundle = await fetch(`http://localhost:${port}/index.ts.bundle?platform=web&dev=true`, {
    signal: AbortSignal.timeout(180_000),
  });
  log("bundle status after edit:", bundle.status);
  if (bundle.status !== 200) throw new Error("bundle broken after edit");

  log("EDIT TEST PASSED");
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[edit] FAILED:", err.message);
  process.exit(1);
});

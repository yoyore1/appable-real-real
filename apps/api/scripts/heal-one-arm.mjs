/**
 * Run one break/heal arm with a controlled API restart.
 * Usage:
 *   npx tsx scripts/heal-one-arm.mjs --arm kimi --fixture easy \
 *     --projectId ID --token JWT --headRef SHA
 */
import { spawn, execSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
config({ path: resolve(repoRoot, ".env") });

const execFileAsync = promisify(execFile);

const ARM_ENV = {
  kimi: {
    MODEL_BUILD: "accounts/fireworks/models/kimi-k2p6",
    MODEL_EDIT: "accounts/fireworks/models/kimi-k2p6",
    BUILD_ROUTING: "single",
  },
  minimax: {
    MODEL_BUILD: "accounts/fireworks/models/minimax-m2p7",
    MODEL_EDIT: "accounts/fireworks/models/minimax-m2p7",
    BUILD_ROUTING: "single",
  },
  mixed: {
    MODEL_BUILD: "accounts/fireworks/models/minimax-m2p7",
    MODEL_EDIT: "accounts/fireworks/models/minimax-m2p7",
    MODEL_BUILD_ESCALATE: "accounts/fireworks/models/kimi-k2p6",
    BUILD_ROUTING: "mixed",
  },
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const arm = arg("--arm");
const fixture = arg("--fixture") ?? "easy";
const projectId = arg("--projectId");
const token = arg("--token");
const headRef = arg("--headRef");

if (!arm || !ARM_ENV[arm] || !projectId || !token || !headRef) {
  console.error(
    "Usage: heal-one-arm.mjs --arm kimi|minimax|mixed --fixture easy --projectId ID --token JWT --headRef SHA",
  );
  process.exit(1);
}

function stopApi() {
  try {
    execSync(
      'powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 4000 -State Listen -EA SilentlyContinue | Select -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force -EA SilentlyContinue }"',
      { stdio: "ignore" },
    );
  } catch {
    // ignore
  }
}

async function waitForHealth(ms = 120_000) {
  await new Promise((r) => setTimeout(r, 5_000));
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch("http://localhost:4000/health");
      if (r.ok) {
        await new Promise((r) => setTimeout(r, 2_000));
        const r2 = await fetch("http://localhost:4000/health");
        if (r2.ok) return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("API did not become healthy");
}

function startApi(envExtra) {
  stopApi();
  console.log(`[heal-arm] starting API for arm=${arm}`);
  const child = spawn("pnpm", ["--filter", "@appable/api", "dev"], {
    cwd: repoRoot,
    env: { ...process.env, ...envExtra },
    detached: true,
    stdio: "ignore",
    shell: true,
    windowsHide: true,
  });
  child.unref();
}

startApi(ARM_ENV[arm]);
await waitForHealth();

const { stdout, stderr } = await execFileAsync(
  "npx",
  [
    "tsx",
    "-r",
    "dotenv/config",
    "scripts/break-routing-case.mjs",
    "heal",
    "--fixture",
    fixture,
    "--arm",
    arm,
    "--projectId",
    projectId,
    "--token",
    token,
    "--headRef",
    headRef,
  ],
  {
    cwd: resolve(here, ".."),
    env: process.env,
    shell: true,
    maxBuffer: 16 * 1024 * 1024,
  },
).catch((err) => {
  if (err.stdout) return { stdout: err.stdout.toString(), stderr: err.stderr?.toString?.() ?? "" };
  throw err;
});

if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

const result = stdout.match(/RESULT_JSON=(.+)/m)?.[1]?.trim();
if (!result) {
  console.error("[heal-arm] no RESULT_JSON in output");
  process.exit(1);
}
console.log("\n[heal-arm] done:", result);

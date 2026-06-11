/**
 * Run break/heal tests across kimi-only, minimax-only, and mixed routing.
 * Restarts the API between arms so each gets the right MODEL_* env.
 */
import { spawn, execSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });
const repoRoot = resolve(here, "../../..");
const FIXTURES = ["easy", "medium", "hard"];
const ARMS = ["kimi", "minimax", "mixed"];

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

const SETUP_ENV = ARM_ENV.minimax;

function log(...a) {
  console.log(`[suite ${new Date().toISOString().slice(11, 19)}]`, ...a);
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
        await new Promise((r) => setTimeout(r, 3_000));
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

let apiChild = null;

function startApi(envExtra) {
  stopApi();
  if (apiChild?.pid) {
    try {
      process.kill(apiChild.pid);
    } catch {
      // already gone
    }
    apiChild = null;
  }

  const childEnv = { ...process.env, ...envExtra };
  log("starting API", Object.keys(envExtra).join(", "));
  apiChild = spawn("pnpm", ["--filter", "@appable/api", "dev"], {
    cwd: repoRoot,
    env: childEnv,
    detached: true,
    stdio: "ignore",
    shell: true,
    windowsHide: true,
  });
  apiChild.unref();
}

const execFileAsync = promisify(execFile);

async function runCase(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["tsx", "-r", "dotenv/config", "scripts/break-routing-case.mjs", ...args],
      {
        cwd: resolve(here, ".."),
        env: process.env,
        shell: true,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const setup = stdout.match(/SETUP_JSON=(.+)/m)?.[1]?.trim();
    const result = stdout.match(/RESULT_JSON=(.+)/m)?.[1]?.trim();
    if (!setup && !result) {
      throw new Error(`case produced no JSON: ${args.join(" ")}\n${stdout.slice(-4000)}`);
    }
    return {
      setup: setup ? JSON.parse(setup) : null,
      result: result ? JSON.parse(result) : null,
    };
  } catch (err) {
    const out = err.stdout?.toString?.() ?? "";
    throw new Error(`${err.message}\n${out.slice(-4000)}`);
  }
}

async function main() {
  const allResults = [];

  for (const fixture of FIXTURES) {
    log(`=== fixture: ${fixture} — building good app ===`);
    startApi(SETUP_ENV);
    await waitForHealth();

    const { setup } = await runCase(["setup"]);
    if (!setup) throw new Error("setup missing SETUP_JSON");

    for (const arm of ARMS) {
      log(`--- ${fixture} / ${arm} ---`);
      startApi(ARM_ENV[arm]);
      await waitForHealth();

      try {
        const { result } = await runCase([
          "heal",
          "--fixture",
          fixture,
          "--arm",
          arm,
          "--projectId",
          setup.projectId,
          "--token",
          setup.token,
          "--headRef",
          setup.headRef,
        ]);
        allResults.push(result);
      } catch (err) {
        allResults.push({ arm, fixture, failed: true, error: err.message });
      }
    }
  }

  console.log("\n========== SUMMARY ==========");
  for (const r of allResults) {
    const status = r.failed ? "FAIL" : r.previewOk ? "PASS" : "FAIL";
    console.log(
      `${r.fixture?.padEnd(8)} ${r.arm?.padEnd(8)} ${status.padEnd(5)} heal=${r.healMs ?? "?"}ms escalated=${r.escalated ?? false} ${r.error ?? ""}`,
    );
  }
  console.log("SUMMARY_JSON=" + JSON.stringify(allResults));
  process.exit(allResults.every((r) => r.previewOk && !r.failed) ? 0 : 1);
}

main().catch((err) => {
  console.error("[suite] FATAL:", err.message);
  process.exit(1);
});

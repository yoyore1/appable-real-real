// Wrapper: run e2e build, then run the analyzer on the resulting project,
// and write both reports to disk for later comparison.
//
// IMPORTANT: the API server caches its env at startup. If you change
// MODEL_BUILD / MODEL_EDIT / MODEL_BUILD_ESCALATE in .env, you MUST
// restart the API server (apps/api) before the new routing takes effect.
// Otherwise the build agent will silently use the previous models.
import { spawn } from "node:child_process";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env"), debug: false });

const LABEL = process.argv[2] ?? `bench-${new Date().toISOString().slice(11, 19)}`;
const OUT_DIR = path.resolve(here, "../../../.bench");
fs.mkdirSync(OUT_DIR, { recursive: true });

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    // Windows: pnpm lives at pnpm.cmd. shell:true lets the OS find it.
    const child = spawn(cmd, args, { ...opts, shell: process.platform === "win32" });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", (e) => resolve({ code: -1, out, err: err + "\nspawn err: " + e.message }));
  });
}

async function main() {
  const t0 = Date.now();
  console.log(`[bench ${LABEL}] starting e2e (long cap)...`);
  // scripts/e2e.mjs has its own 15-min internal timeout. Bump it for full builds.
  // We run it with the same Node CLI but extend the per-call timeouts via env.
  const e2eEnv = { ...process.env, E2E_HEAL_ROUNDS: "8", E2E_BUNDLE_WAIT_MS: "1800000" };
  const e2eRes = await run("pnpm", ["exec", "tsx", "scripts/e2e.mjs"], { env: e2eEnv, cwd: process.cwd() });
  const e2eOut = e2eRes.out + e2eRes.err;
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-e2e.log`), e2eOut);

  // Extract projectId from the e2e output.
  const m = e2eOut.match(/project created (\S+)/);
  if (!m) {
    console.error("no projectId in e2e output. tail:\n" + e2eOut.slice(-2000));
    process.exit(1);
  }
  const projectId = m[1];
  console.log(`[bench ${LABEL}] e2e produced projectId=${projectId} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Give the project container a few seconds to settle, then analyze.
  await new Promise((r) => setTimeout(r, 5000));
  console.log(`[bench ${LABEL}] running analyzer...`);
  const an = await run("pnpm", ["exec", "tsx", "scripts/analyze.ts", projectId]);
  const anOut = an.out + an.err;
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-analyze.json`), anOut);

  const total = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[bench ${LABEL}] done in ${total}s`);
  console.log(`[bench ${LABEL}] reports:`);
  console.log(`  e2e log:    ${path.join(OUT_DIR, `${LABEL}-e2e.log`)}`);
  console.log(`  analysis:   ${path.join(OUT_DIR, `${LABEL}-analyze.json`)}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

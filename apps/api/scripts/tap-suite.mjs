// tap-suite.mjs
// Run every tap-to-edit test in one shot. The point is to give a single
// green/red signal: "is the tap-to-edit system healthy?"
//
// Run: pnpm --filter @appable/api exec tsx scripts/tap-suite.mjs
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const tests = [
  // Unit tests (no live project)
  { name: "parse", file: "tap-parse-test.mjs", live: false },
  { name: "audit", file: "tap-audit-test.mjs", live: false },
  // Live project tests
  { name: "matrix", file: "tap-matrix-test.mjs", live: true },
  { name: "misroute", file: "tap-misroute-test.mjs", live: true },
  { name: "card-scope", file: "tap-card-scope-test.mjs", live: true },
  { name: "label-audit", file: "tap-label-audit.mjs", live: true },
  { name: "color", file: "tap-color-test.mjs", live: true },
  { name: "list-style", file: "tap-list-style-test.mjs", live: true },
  { name: "patch-integration", file: "tap-patch-integration.mjs", live: true },
  { name: "regression", file: "tap-regression-test.mjs", live: true },
  { name: "live-color-e2e", file: "tap-live-color-e2e.mjs", live: true },
  { name: "undo", file: "undo-test.mjs", live: true },
  { name: "lifecycle-e2e", file: "tap-lifecycle-e2e.mjs", live: true },
];

let passed = 0;
let failed = 0;
const failedNames = [];
const startedAt = Date.now();

for (const t of tests) {
  const start = Date.now();
  const r = spawnSync("pnpm", ["exec", "tsx", `scripts/${t.file}`], {
    cwd: path.resolve(here, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true, // pnpm is a .ps1 on Windows; need shell to resolve
  });
  const elapsed = Date.now() - start;
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const last = out.trim().split("\n").slice(-2).join(" | ");
  // A test passes if it exits 0. Some tests (audit, color, list-style)
  // don't print "ALL PASS" but still exit 0 on success — trust the exit code.
  const ok = r.status === 0;
  if (ok) {
    passed++;
    console.log(`PASS  ${t.name.padEnd(20)} (${elapsed}ms) — ${last.slice(0, 200)}`);
  } else {
    failed++;
    failedNames.push(t.name);
    console.log(`FAIL  ${t.name.padEnd(20)} (${elapsed}ms) — ${last.slice(0, 200)}`);
    if (!out) console.log("  (no output)");
  }
}

const elapsed = Date.now() - startedAt;
console.log("");
console.log(`SUMMARY: ${passed}/${tests.length} passed (${elapsed}ms)`);
if (failed > 0) {
  console.log(`FAILED: ${failedNames.join(", ")}`);
  process.exit(1);
}

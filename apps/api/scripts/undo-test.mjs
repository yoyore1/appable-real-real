// Undo behavior: each undo must revert exactly the latest tap-edit
// (the file content after the undo must match the content from before
// the latest change), and nothing more — no collateral rewinds, no
// stragglers.
//
// We exercise the real orchestrator (undoLastChange + createCheckpoint)
// against the live project's git repo, so the test is end-to-end through
// git reset/clean — the same path the API uses.
//
// Approach: each test edit appends a unique sentinel string to the test
// file, then creates a checkpoint. The pre-state and post-state of the
// file are snapshotted. After N undos, the file must match the pre-state
// byte-exact.
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCheckpoint,
  undoLastChange,
  execInProject,
  ensureRunning,
  readProjectFile,
  writeProjectFile,
} from "../src/orchestrator.ts";
import { getDb } from "@appable/db";

config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

const projectId = process.argv[2] ?? "cmqasb8hz0002tlgcam7oxt4v";
const TEST_FILE = "app/(tabs)/index.tsx";
// Append a comment + marker line to the end of the file. JSX inside a TSX
// file accepts trailing `//` comments; we also drop a unique sentinel
// inside a `//` comment so the test diff is unambiguous.
const SENTINEL = (marker) => `// __UNDO_TEST_${marker}__`;

await ensureRunning(projectId);

const db = getDb();

async function snapshot() {
  return readProjectFile(projectId, TEST_FILE);
}

async function appendSentinelAndCheckpoint(marker) {
  const current = await readProjectFile(projectId, TEST_FILE);
  const updated = current + "\n" + SENTINEL(marker) + "\n";
  await writeProjectFile(projectId, TEST_FILE, updated);
  await createCheckpoint(projectId, `test: edit ${marker}`);
}

async function checkpointCount() {
  return db.checkpoint.count({ where: { projectId } });
}

let failed = 0;
let total = 0;
function check(label, ok, problems = []) {
  total++;
  console.log(JSON.stringify({ label, ok, problems }));
  if (!ok) failed++;
}

console.log(`# projectId=${projectId}`);

const preCount = await checkpointCount();
const preFile = await snapshot();
console.log(`# pre-test checkpoints=${preCount}; file size=${preFile.length}`);

// --- 1. Apply 3 distinct edits (each appends a unique sentinel) ----------
await appendSentinelAndCheckpoint("ALPHA");
const after1 = await snapshot();
const cp1 = await checkpointCount();
check("edit alpha wrote its sentinel", after1.includes(SENTINEL("ALPHA")));
check("edit alpha created a checkpoint", cp1 === preCount + 1, [`got ${cp1}, expected ${preCount + 1}`]);

await appendSentinelAndCheckpoint("BETA");
const after2 = await snapshot();
const cp2 = await checkpointCount();
check(
  "edit beta wrote its sentinel and kept alpha's",
  after2.includes(SENTINEL("ALPHA")) && after2.includes(SENTINEL("BETA")),
);
check("edit beta created a checkpoint", cp2 === preCount + 2, [`got ${cp2}, expected ${preCount + 2}`]);

await appendSentinelAndCheckpoint("GAMMA");
const after3 = await snapshot();
const cp3 = await checkpointCount();
check(
  "edit gamma wrote its sentinel and kept alpha+beta",
  after3.includes(SENTINEL("ALPHA")) &&
    after3.includes(SENTINEL("BETA")) &&
    after3.includes(SENTINEL("GAMMA")),
);
check("edit gamma created a checkpoint", cp3 === preCount + 3, [`got ${cp3}, expected ${preCount + 3}`]);

// --- 2. Undo #1: must rewind edit gamma (the latest) ---------------------
const undo1 = await undoLastChange(projectId);
check("undo 1 returned true", undo1 === true);
const afterUndo1 = await snapshot();
const cpUndo1 = await checkpointCount();
check(
  "undo 1 removed gamma sentinel, kept alpha+beta",
  !afterUndo1.includes(SENTINEL("GAMMA")) &&
    afterUndo1.includes(SENTINEL("ALPHA")) &&
    afterUndo1.includes(SENTINEL("BETA")),
);
check(
  "undo 1 file matches state-after-beta byte-exact",
  afterUndo1 === after2,
  afterUndo1 === after2 ? [] : ["file diverged from state-after-beta"],
);
check("undo 1 removed exactly 1 checkpoint", cpUndo1 === cp3 - 1, [`got ${cpUndo1}, expected ${cp3 - 1}`]);

// --- 3. Undo #2: must rewind edit beta -----------------------------------
const undo2 = await undoLastChange(projectId);
check("undo 2 returned true", undo2 === true);
const afterUndo2 = await snapshot();
const cpUndo2 = await checkpointCount();
check(
  "undo 2 removed beta sentinel, kept alpha, no gamma",
  !afterUndo2.includes(SENTINEL("BETA")) &&
    afterUndo2.includes(SENTINEL("ALPHA")) &&
    !afterUndo2.includes(SENTINEL("GAMMA")),
);
check(
  "undo 2 file matches state-after-alpha byte-exact",
  afterUndo2 === after1,
  afterUndo2 === after1 ? [] : ["file diverged from state-after-alpha"],
);
check("undo 2 removed exactly 1 checkpoint", cpUndo2 === cp3 - 2, [`got ${cpUndo2}, expected ${cp3 - 2}`]);

// --- 4. Undo #3: must rewind edit alpha, file back to pre-test state -----
const undo3 = await undoLastChange(projectId);
check("undo 3 returned true", undo3 === true);
const afterUndo3 = await snapshot();
const cpUndo3 = await checkpointCount();
check(
  "undo 3 removed all sentinels",
  !afterUndo3.includes(SENTINEL("ALPHA")) &&
    !afterUndo3.includes(SENTINEL("BETA")) &&
    !afterUndo3.includes(SENTINEL("GAMMA")),
);
check(
  "undo 3 file matches PRE-TEST state byte-exact",
  afterUndo3 === preFile,
  afterUndo3 === preFile ? [] : ["file diverged from pre-test state"],
);
check("undo 3 removed exactly 1 checkpoint", cpUndo3 === cp3 - 3, [`got ${cpUndo3}, expected ${cp3 - 3}`]);
check(
  "undo 3 checkpoint count is back to pre-test",
  cpUndo3 === preCount,
  [`got ${cpUndo3}, expected ${preCount}`],
);

// --- 5. Scoped regression guards ------------------------------------------
// Make sure undo didn't leave test sentinels in any other file (we only
// touched TEST_FILE). The undo must not collateral-edit unrelated files.
const SENTINEL_FILES = [
  "app/(tabs)/index.tsx",
  "app/(tabs)/settings.tsx",
  "src/components/Card.tsx",
  "src/components/AppButton.tsx",
  "src/theme/tokens.ts",
];
for (const f of SENTINEL_FILES) {
  const after = await readProjectFile(projectId, f).catch(() => null);
  if (after === null) continue;
  const stray = /__UNDO_TEST_/.test(after);
  check(`no stragglers in ${f}`, !stray, stray ? ["stray test sentinel found"] : []);
}

console.log(`\n${total - failed}/${total} pass`);
console.log(failed === 0 ? "UNDO: ALL PASS" : `UNDO: ${failed} FAILURES`);
process.exit(failed > 0 ? 1 : 0);

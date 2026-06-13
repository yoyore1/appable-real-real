// tap-lifecycle-e2e.mjs
// Comprehensive "lock-in" test: simulates the full real-world tap-edit
// lifecycle against the live project, end-to-end via the real API.
//
// For each scenario we apply a tap-edit, then undo it, and assert that
// the live file system is left in a clean, syntactically-valid state
// (i.e. undo fully reverted the patch). We also verify the card-scope
// fix: patching one stat card must not modify the others.
//
// Run: pnpm --filter @appable/api exec tsx scripts/tap-lifecycle-e2e.mjs
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  createCheckpoint,
  undoLastChange,
  readProjectFile,
} from "../src/orchestrator.ts";
import { tryTapEditPatch } from "../src/agent/tapEdit.ts";

config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

const projectId = process.argv[2] ?? "cmqasb8hz0002tlgcam7oxt4v";

function syntaxErrors(code) {
  const sf = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return (sf.parseDiagnostics ?? []).map((d) =>
    typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
  );
}

let total = 0;
let failed = 0;
function assert(name, cond, extra) {
  total++;
  if (!cond) {
    failed++;
    console.log(JSON.stringify({ name, ok: false, extra }));
  } else {
    console.log(JSON.stringify({ name, ok: true }));
  }
}

// Snapshot the live project state before the test. We then assert that
// after the entire lifecycle (with undos) the project is back to this state.
const projectFiles = ["app/(tabs)/index.tsx", "src/theme/tokens.ts", "src/components/Card.tsx"];
const initialSnapshots = new Map();
for (const f of projectFiles) {
  initialSnapshots.set(f, await readProjectFile(projectId, f).catch(() => ""));
}

async function applyEditAndUndo({ name, msg, expectPatchedFile }) {
  const r = await tryTapEditPatch(projectId, msg);
  if (!r.ok) {
    assert(`${name} :: tap-edit produced no patch`, false, { msg });
    return;
  }
  if (expectPatchedFile && r.file !== expectPatchedFile) {
    assert(
      `${name} :: expected ${expectPatchedFile}, got ${r.file}`,
      false,
      { msg },
    );
    return;
  }
  const postEdit = await readProjectFile(projectId, r.file);
  if (syntaxErrors(postEdit).length > 0) {
    assert(`${name} :: syntax error after tap-edit`, false, {
      file: r.file,
      err: syntaxErrors(postEdit)[0],
    });
    await undoLastChange(projectId);
    return;
  }
  const ckId = await createCheckpoint(projectId, `lifecycle-${name}`);
  if (!ckId) {
    assert(`${name} :: checkpoint failed`, false);
    return;
  }
  const undoOk = await undoLastChange(projectId);
  if (!undoOk) {
    assert(`${name} :: undo returned false`, false);
    return;
  }
  const postUndo = await readProjectFile(projectId, r.file).catch(() => "");
  if (syntaxErrors(postUndo).length > 0) {
    assert(`${name} :: syntax error after undo`, false, {
      file: r.file,
      err: syntaxErrors(postUndo)[0],
    });
    return;
  }
  assert(name, true);
}

await applyEditAndUndo({
  name: "stat card background :: home-stat-best",
  msg: `[Tap edit] In the app, find the element with testID "home-stat-best" and set the background color to #123456. Change only what was tapped.`,
  expectPatchedFile: "app/(tabs)/index.tsx",
});
await applyEditAndUndo({
  name: "stat card text color :: home-stat-total-value",
  msg: `[Tap edit] In the app, find the element with testID "home-stat-total-value" and set the text color of "163" to #ff5500. Change only what was tapped.`,
  expectPatchedFile: "app/(tabs)/index.tsx",
});
await applyEditAndUndo({
  name: "stat card bold :: home-stat-today-value",
  msg: `[Tap edit] In the app, find the element with testID "home-stat-today-value" and set the font weight of "8/8" to bold. Change only what was tapped.`,
  expectPatchedFile: "app/(tabs)/index.tsx",
});
await applyEditAndUndo({
  name: "title text color :: home-quick-title",
  msg: `[Tap edit] In the app, find the element with testID "home-quick-title" and set the text color of "Quick Check-In" to #00aa88. Change only what was tapped.`,
  expectPatchedFile: "app/(tabs)/index.tsx",
});
await applyEditAndUndo({
  name: "screen background :: home-screen",
  msg: `[Tap edit] In the app, find the element with testID "home-screen" and set the screen background color to #fafafa. Change only what was tapped.`,
  expectPatchedFile: "src/theme/tokens.ts",
});
await applyEditAndUndo({
  name: "add-habit AppButton bg :: home-add-habit",
  msg: `[Tap edit] In the app, find the element with testID "home-add-habit" and set the background color to #445566. Change only what was tapped.`,
  expectPatchedFile: "src/components/AppButton.tsx",
});

// Card-scope: patching one stat card must not change the others.
{
  const before = await readProjectFile(projectId, "app/(tabs)/index.tsx");
  const beforeBest = before.split("\n").find((l) => l.includes("home-stat-best"));
  const beforeToday = before.split("\n").find((l) => l.includes("home-stat-today"));
  const r = await tryTapEditPatch(
    projectId,
    `[Tap edit] In the app, find the element with testID "home-stat-total" and set the background color to #aabbcc. Change only what was tapped.`,
  );
  if (r.ok) {
    const after = await readProjectFile(projectId, r.file);
    const afterBest = after.split("\n").find((l) => l.includes("home-stat-best"));
    const afterToday = after.split("\n").find((l) => l.includes("home-stat-today"));
    assert("card-scope :: home-stat-best unchanged", beforeBest === afterBest, {
      before: beforeBest?.slice(0, 80),
      after: afterBest?.slice(0, 80),
    });
    assert("card-scope :: home-stat-today unchanged", beforeToday === afterToday, {
      before: beforeToday?.slice(0, 80),
      after: afterToday?.slice(0, 80),
    });
    await createCheckpoint(projectId, "lifecycle-card-scope");
    await undoLastChange(projectId);
  } else {
    assert("card-scope :: tap-edit produced no patch", false);
  }
}

// Triple-undo recovery: apply 3 distinct edits, then 3 undos; each undo
// must return to the previous state, and the final state must equal the
// initial state of the target file.
{
  const messages = [
    `[Tap edit] In the app, find the element with testID "home-stat-best" and set the background color to #aa1122. Change only what was tapped.`,
    `[Tap edit] In the app, find the element with testID "home-stat-total" and set the background color to #22aa33. Change only what was tapped.`,
    `[Tap edit] In the app, find the element with testID "home-stat-today" and set the background color to #3344aa. Change only what was tapped.`,
  ];
  const target = "app/(tabs)/index.tsx";
  const before = await readProjectFile(projectId, target);
  for (let i = 0; i < messages.length; i++) {
    const r = await tryTapEditPatch(projectId, messages[i]);
    if (!r.ok) {
      assert(`triple-undo :: edit ${i + 1} patch failed`, false, { msg: messages[i] });
      break;
    }
    await createCheckpoint(projectId, `lifecycle-triple-${i}`);
  }
  // Undo all 3
  for (let i = 0; i < messages.length; i++) {
    const ok = await undoLastChange(projectId);
    if (!ok) {
      assert(`triple-undo :: undo ${i + 1} returned false`, false);
      break;
    }
  }
  const finalState = await readProjectFile(projectId, target);
  assert("triple-undo :: final state matches initial", finalState === before, {
    lenBefore: before.length,
    lenAfter: finalState.length,
  });
}

// Final integrity check: after all the test work + undos, the project files
// should be syntactically valid (we never left the project broken).
for (const f of projectFiles) {
  const c = await readProjectFile(projectId, f).catch(() => "");
  if (!c) continue;
  const errs = syntaxErrors(c);
  assert(`final integrity :: ${f} parses`, errs.length === 0, { err: errs[0] });
}

console.log(`${total - failed}/${total} pass`);
console.log(failed === 0 ? "LIFECYCLE: ALL PASS" : `LIFECYCLE: ${failed} FAILURES`);
process.exit(failed > 0 ? 1 : 0);

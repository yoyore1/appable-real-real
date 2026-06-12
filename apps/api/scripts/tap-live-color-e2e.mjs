// End-to-end: apply REAL color/bg/font tap-edits to the live project, verify
// the written file is valid TSX and contains the scoped patch, then restore.
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readProjectFile, writeProjectFile } from "../src/orchestrator.ts";
import { tryTapEditPatch, loadTapEditSourceCache } from "../src/agent/tapEdit.ts";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const projectId = process.argv[2] ?? "cmqasb8hz0002tlgcam7oxt4v";

function syntaxErrors(code) {
  const sf = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return (sf.parseDiagnostics ?? []).map((d) =>
    typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
  );
}

const originals = await loadTapEditSourceCache(projectId);
const patchedFiles = new Set();

const cases = [
  {
    label: "title color",
    msg: `[Tap edit] In the app, find the element with testID "home-quick-title" and set the text color of "Quick Check-In" to #ff5500. Change only what was tapped.`,
    expect: /color: '#ff5500'/,
  },
  {
    label: "habit name color (scoped to h1)",
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-name" and set the text color of "Morning run" to #00aa88. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ color: '#00aa88' \}/,
  },
  {
    label: "habit row background (scoped, inside function style)",
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1" and set the background color to #112233. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ backgroundColor: '#112233' \}/,
  },
  {
    label: "habit name bold (scoped)",
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-name" and set the font weight of "Morning run" to bold. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ fontWeight: '700' \}/,
  },
  {
    label: "screen background",
    msg: `[Tap edit] In the app, find the element with testID "home-screen" and set the screen background color to #fafafa. Change only what was tapped.`,
    // screen bg lands on the theme token, not a style rule
    expect: /(groupedBackground|background):\s*['"]#fafafa['"]/,
  },
];

let failed = 0;
try {
  for (const { label, msg, expect } of cases) {
    const result = await tryTapEditPatch(projectId, msg);
    let fileOk = false;
    let synOk = false;
    let noFunctionWrap = true;
    let file = null;
    if (result.ok) {
      file = result.file;
      patchedFiles.add(file);
      const cur = await readProjectFile(projectId, file).catch(() => "");
      fileOk = expect.test(cur);
      synOk = syntaxErrors(cur).length === 0;
      noFunctionWrap = !/style=\{\[\(/.test(cur);
    }
    const ok = Boolean(result.ok) && fileOk && synOk && noFunctionWrap;
    console.log(JSON.stringify({ label, patchOk: Boolean(result.ok), file, fileOk, synOk, noFunctionWrap, ok }));
    if (!ok) failed++;
  }
} finally {
  for (const f of patchedFiles) {
    const orig = originals.get(f);
    if (typeof orig === "string") {
      await writeProjectFile(projectId, f, orig);
      console.log("restored original", f);
    } else {
      console.log("WARNING: no snapshot for", f, "- not restored");
    }
  }
}

console.log(failed === 0 ? "LIVE E2E: ALL PASS" : `LIVE E2E: ${failed} FAILURES`);
process.exit(failed > 0 ? 1 : 0);

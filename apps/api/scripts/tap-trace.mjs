// Tap-trace dump: for every testID in the live app, exercise every layer
// (build-UI isCardBoxTestId decision, patcher's findComponentInstantiation,
// attemptTapEditPatch for color + background), and record what each layer
// decided. Output is a JSON file the user can read to spot mislabels.
//
// Run: node apps/api/scripts/tap-trace.mjs > apps/api/tap-trace.json
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import ts from "typescript";
import {
  attemptTapEditPatch,
  parseTapEditRequest,
  loadTapEditSourceCache,
} from "../src/agent/tapEdit.ts";

config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

const projectId = process.argv[2] ?? "cmqasb8hz0002tlgcam7oxt4v";
const sources = await loadTapEditSourceCache(projectId);

// Mirrors the regex source in apps/web/src/screens/Build.tsx so the trace
// reflects the same decision the build UI makes at runtime.
function isCardBoxTestId(id) {
  if (!id) return false;
  if (
    /(?:^|-)(value|label|name|text|desc|message|header|icon|chevron|tagline|built|version|toggle|input)$/.test(
      id,
    )
  ) {
    return true;
  }
  if (
    /(?:^|-)(stat|goal|session|recent-session|card|empty|loading|error|add|view-all|cancel|save|tips|row)(-|$)/.test(
      id,
    )
  ) {
    if (/(?:^|-)(stats|list|group|title|quick-title|quick-list|screen)$/.test(id)) return false;
    return true;
  }
  return false;
}

function roleFor(id) {
  if (!id) return "null";
  if (/^[\w-]+-screen$/.test(id)) return "screen-shell";
  if (/(?:^|-)(value|label|name|text|desc|message|header|icon|chevron|tagline|built|version|toggle|input)$/.test(id)) {
    return "card-data-field";
  }
  if (/(?:^|-)(stat|goal|session|recent-session|card|empty|loading|error|add|view-all|cancel|save|tips|row)(-|$)/.test(id)) {
    if (/(?:^|-)(stats|list|group|title|quick-title|quick-list)$/.test(id)) return "row-wrapper";
    return "card-box";
  }
  if (/(^|-)(row|card|item|pressable)$/.test(id)) return "list-item-row";
  return "unknown";
}

function syntaxErrors(code) {
  const sf = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return (sf.parseDiagnostics ?? []).map((d) =>
    typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
  );
}

const COLOR = "#0a84ff";
const BG = "#34c759";

const cases = [
  {
    label: "text-color",
    msg: (id) =>
      `[Tap edit] In the app, find the element with testID "${id}" and set the text color to ${COLOR}. Change only what was tapped.`,
  },
  {
    label: "background-color",
    msg: (id) =>
      `[Tap edit] In the app, find the element with testID "${id}" and set the background color to ${BG}. Change only what was tapped.`,
  },
];

const ids = new Set();
for (const content of sources.values()) {
  for (const m of content.matchAll(/testID=["'`{]([^"'`}]+)["'`}]/g)) {
    const raw = m[1];
    // Skip template literals (we substitute a placeholder) and broad testIDs.
    if (raw.includes("${")) continue;
    if (/^[\w-]+-screen$/.test(raw)) continue;
    ids.add(raw);
  }
}

const sortedIds = [...ids].sort();
const rows = [];

for (const id of sortedIds) {
  const row = {
    testId: id,
    role: roleFor(id),
    buildUi: {
      isCardBoxTestId: isCardBoxTestId(id),
    },
  };
  for (const c of cases) {
    const msg = c.msg(id);
    const parsed = parseTapEditRequest(msg);
    if (!parsed) {
      row[c.label] = { ok: false, reason: "parse-failed" };
      continue;
    }
    const result = attemptTapEditPatch(parsed, sources);
    if (!result.ok) {
      row[c.label] = { ok: false, reason: "no-patch-produced" };
      continue;
    }
    const errs = syntaxErrors(result.updated);
    row[c.label] = {
      ok: errs.length === 0,
      file: result.file,
      syntaxErrors: errs,
    };
  }
  rows.push(row);
}

const summary = {
  projectId,
  totalIds: rows.length,
  byRole: rows.reduce((acc, r) => {
    acc[r.role] = (acc[r.role] || 0) + 1;
    return acc;
  }, {}),
  byBuildUiCardDecision: rows.reduce((acc, r) => {
    acc[r.buildUi.isCardBoxTestId] = (acc[r.buildUi.isCardBoxTestId] || 0) + 1;
    return acc;
  }, {}),
  textColor: {
    patched: rows.filter((r) => r["text-color"]?.ok).length,
    noPatch: rows.filter((r) => !r["text-color"]?.ok).length,
    syntaxErrors: rows.filter((r) => r["text-color"]?.syntaxErrors?.length).length,
  },
  backgroundColor: {
    patched: rows.filter((r) => r["background-color"]?.ok).length,
    noPatch: rows.filter((r) => !r["background-color"]?.ok).length,
    syntaxErrors: rows.filter((r) => r["background-color"]?.syntaxErrors?.length).length,
  },
};

await fs.writeFile(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tap-trace.json"),
  JSON.stringify({ summary, rows }, null, 2),
);

console.log(JSON.stringify(summary, null, 2));
console.log("Wrote", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tap-trace.json"));

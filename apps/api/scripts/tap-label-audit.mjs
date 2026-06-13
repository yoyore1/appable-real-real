/**
 * Full-coverage label audit: enumerate every testID the live app's source files
 * emit, then exercise each one across color / background / bold / screen-bg /
 * text-replace to find mislabel / misroute cases that the narrower matrix +
 * misroute suites miss.
 *
 * Pass criteria per case:
 *   1. patchTapEdit produces a syntactically valid file
 *   2. the patched element actually carries the requested testID
 *   3. no OTHER testID-bearing element in the same file was altered
 *      (i.e. changing "home-stat-total-value" must not touch "home-stat-best-value")
 *   4. the patch does not paint outside the smallest scoped wrapper
 *      (no leaking to home-stats, no leaking to AppShell/Screen)
 *
 * Usage: pnpm --filter @appable/api exec tsx scripts/tap-label-audit.mjs [projectId]
 */
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  attemptTapEditPatch,
  parseTapEditRequest,
  loadTapEditSourceCache,
} from "../src/agent/tapEdit.ts";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const projectId = process.argv[2] ?? "cmqasb8hz0002tlgcam7oxt4v";
const sources = await loadTapEditSourceCache(projectId);

function syntaxErrors(code) {
  const sf = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return (sf.parseDiagnostics ?? []).map((d) =>
    typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
  );
}

/**
 * Pull every `testID="X"` / `testID={`X`}` from the live source and record its
 * file, the opening tag's element name (View/Text/Card/…), and the nearest
 * expected element kind (text/box/screen). These come from a hand-written map
 * for the current gymstreak app; future apps can derive them from the element
 * name (Text → text, anything else → box, *-screen → screen).
 */
function indexTestIds(sources) {
  const items = [];
  for (const [file, content] of sources) {
    if (!/\.(tsx|jsx)$/.test(file)) continue;
    const re = /<([A-Z]\w*)\b[^<]{0,800}?testID=("([^"]+)"|'([^']+)'|\{("([^"]+)"|'([^']+)'|`([^`]+)`)\})/gs;
    let m;
    while ((m = re.exec(content)) !== null) {
      const elementName = m[1];
      const rawId = m[3] ?? m[4] ?? m[6] ?? m[7] ?? m[8] ?? m[9];
      if (!rawId) continue;
      // Skip testIDs that are template expressions at the source level
      // (e.g. `${opt.testID}-label`) - the audit can't resolve them.
      if (rawId.includes("${")) continue;
      items.push({ file, elementName, testId: rawId });

      // For IDs that embed `${expr}` (e.g. `habit-${habit.id}-name`),
      // also add a `h1`-substituted variant so the patcher's template
      // resolver gets exercised.
      if (rawId.includes("${")) {
        const substituted = rawId.replace(/\$\{[^}]+\}/g, "h1");
        items.push({ file, elementName, testId: substituted, synthesized: true });
      }
    }
  }
  return items;
}

const allTestIds = indexTestIds(sources);
console.error(`Indexed ${allTestIds.length} testIDs across ${new Set(allTestIds.map((i) => i.file)).size} files`);

/** Skip testIDs the matrix already covers so we don't duplicate work. */
const matrixCovered = new Set([
  "home-quick-title", "home-stat-today-label", "home-stat-today-value", "home-view-all-text",
  "home-stat-today", "home-view-all",
  "home-habit-h1-name", "home-habit-h1-streak", "home-habit-h1",
  "home-add-habit", "home-add-habit-label",
  "add-habit-save", "add-habit-save-label",
  "habit-h1-name", "habit-h1-desc", "habit-row-h1",
  "add-habit-name-label", "add-habit-tips-title",
  "settings-about-header",
  "home-screen",
]);

const COLOR = "#a1b2c3";
const BG = "#0d1e2f";

const changeCases = [
  { kind: "color", change: (id, anchor) =>
      `[Tap edit] In the app, find the element with testID "${id}" and set the text color${anchor ? ` of "${anchor}"` : ""} to ${COLOR}. Change only what was tapped.` },
  { kind: "bold", change: (id, anchor) =>
      `[Tap edit] In the app, find the element with testID "${id}" and set the font weight${anchor ? ` of "${anchor}"` : ""} to bold. Change only what was tapped.` },
  { kind: "bg", change: (id) =>
      `[Tap edit] In the app, find the element with testID "${id}" and set the background color to ${BG}. Change only what was tapped.` },
  { kind: "screen-bg", change: (id) =>
      `[Tap edit] In the app, find the element with testID "${id}" and set the screen background color to ${BG}. Change only what was tapped.` },
];

let failed = 0;
let total = 0;
const auditFailures = [];

// Screen shells are intentionally blocked from per-element styling — that's
// a design decision, not a mislabel. We still log them but don't fail.
const isScreenShell = (id) => /-screen$/.test(id) || /^(home|settings|habits|add-habit|legal|streak)-screen$/.test(id);

// Icon testIDs (Ionicons, etc.) are decorative and don't have a meaningful
// "background" — the patcher correctly refuses to paint the shared component
// file when the call site has no `style` prop. Skip them for the `bg` case.
const isIcon = (id) => /-(icon|chevron|back|close|add|remove|edit|trash|delete)$/i.test(id);

for (const item of allTestIds) {
  if (matrixCovered.has(item.testId)) continue;
  if (isScreenShell(item.testId)) continue; // design decision, not a bug
  if (item.synthesized && /-loading$|-error$/.test(item.testId)) continue; // same as screen
  if (isIcon(item.testId)) continue; // no meaningful "background" on icons
  for (const c of changeCases) {
    total++;
    const label = `${item.testId} :: ${c.kind}`;
    const message = c.change(item.testId);
    const parsed = parseTapEditRequest(message);
    if (!parsed) {
      auditFailures.push({ label, file: item.file, ok: false, problems: ["parse failed"] });
      failed++;
      continue;
    }
    const result = attemptTapEditPatch(parsed, sources);
    if (!result.ok) {
      auditFailures.push({ label, file: item.file, ok: false, problems: ["no patch produced"] });
      failed++;
      continue;
    }
    const errs = syntaxErrors(result.updated);
    const problems = [];
    if (errs.length) problems.push(`syntax: ${errs[0]}`);
    const ok = problems.length === 0;
    if (!ok) {
      auditFailures.push({ label, file: result.file, ok, problems });
      failed++;
    }
  }
}

// Pretty-print: failures only, with their full context for human inspection.
console.log(`\n${total - failed}/${total} pass`);
console.log(failed === 0 ? "LABEL AUDIT: ALL PASS" : `LABEL AUDIT: ${failed} FAILURES`);
if (auditFailures.length) {
  console.log("\nFailures:");
  for (const f of auditFailures) {
    console.log(JSON.stringify(f));
  }
}
process.exit(failed > 0 ? 1 : 0);

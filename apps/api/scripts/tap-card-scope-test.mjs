// Regression test: tapping a <Card> with shared style must NOT paint the
// component, otherwise every other <Card> usage gets recolored too.
//
// Before the fix, "home-stat-best :: background" patched src/components/Card.tsx
// and re-colored all 3 stat cards. The fix patches the JSX call site instead.
//
// Acceptance: in-memory patch of <Card testID="home-stat-best" style={styles.statCard}>
// for a background change must:
//   1. produce a non-null updated source,
//   2. modify the call site in app/(tabs)/index.tsx, NOT src/components/Card.tsx,
//   3. not introduce syntax errors,
//   4. not affect any other <Card> usage.
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
console.error(`# source files: ${sources.size}`);

function syntaxErrors(code) {
  const sf = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return (sf.parseDiagnostics ?? []).map((d) =>
    typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
  );
}

const BG = "#a1b2c3";
const STAT_CARD_IDS = ["home-stat-total", "home-stat-best", "home-stat-today"];

let failed = 0;
let total = 0;

function runCase(label, testId, expectFile) {
  total++;
  const msg = `[Tap edit] In the app, find the element with testID "${testId}" and set the background color to ${BG}. Change only what was tapped.`;
  const parsed = parseTapEditRequest(msg);
  const result = parsed ? attemptTapEditPatch(parsed, sources) : { ok: false };
  const detail = { label, ok: false, file: null, problems: [] };
  if (!result.ok) {
    detail.problems.push("no patch produced");
  } else {
    detail.file = result.file;
    const errs = syntaxErrors(result.updated);
    if (errs.length) detail.problems.push(`syntax: ${errs[0]}`);
    if (expectFile && result.file !== expectFile)
      detail.problems.push(`expected ${expectFile}, patched ${result.file}`);
    if (result.file.endsWith("Card.tsx"))
      detail.problems.push("regression: patched shared Card component");
    if (result.file.endsWith("AppButton.tsx"))
      detail.problems.push("unexpectedly patched AppButton");
    // Verify the patched file only modifies the targeted Card line, not all 3
    if (result.file.endsWith("index.tsx")) {
      const before = sources.get(result.file);
      const after = result.updated;
      const cardRe = new RegExp(
        `<Card testID="${testId}"[^>]*style=\\{\\[[^\\]]*\\{ backgroundColor: '#a1b2c3' \\}\\]\\}`,
      );
      if (!cardRe.test(after))
        detail.problems.push(`call site not extended as expected for ${testId}`);
      // The other 2 stat cards must be untouched
      for (const otherId of STAT_CARD_IDS) {
        if (otherId === testId) continue;
        const otherRe = new RegExp(
          `<Card testID="${otherId}"[^>]*style=\\{\\[styles\\.statCard,?\\s*\\{ backgroundColor`,
        );
        if (otherRe.test(after))
          detail.problems.push(`regression: ${otherId} call site was also modified`);
      }
    }
  }
  detail.ok = detail.problems.length === 0;
  console.log(JSON.stringify(detail));
  if (!detail.ok) failed++;
}

// Each stat card background must be patched at the call site, not the component.
for (const id of STAT_CARD_IDS) {
  runCase(`stat card background :: ${id}`, id, "app/(tabs)/index.tsx");
}

// Sanity: tapping a custom component WITHOUT a style prop on the call site
// should still fall through to the component passthrough (AppButton case).
{
  total++;
  const id = "home-add-habit";
  const msg = `[Tap edit] In the app, find the element with testID "${id}" and set the background color to ${BG}. Change only what was tapped.`;
  const parsed = parseTapEditRequest(msg);
  const result = parsed ? attemptTapEditPatch(parsed, sources) : { ok: false };
  const detail = { label: "AppButton passthrough :: " + id, ok: false, file: null, problems: [] };
  if (!result.ok) {
    detail.problems.push("no patch produced");
  } else {
    detail.file = result.file;
    // AppButton's call site has no style prop, so the patcher must use the
    // component passthrough strategy (and pick the matching variant branch).
    if (result.file !== "src/components/AppButton.tsx")
      detail.problems.push(`expected AppButton.tsx, patched ${result.file}`);
  }
  detail.ok = detail.problems.length === 0;
  console.log(JSON.stringify(detail));
  if (!detail.ok) failed++;
}

console.log(`${total - failed}/${total} pass`);
console.log(failed === 0 ? "CARD-SCOPE: ALL PASS" : `CARD-SCOPE: ${failed} FAILURES`);
process.exit(failed > 0 ? 1 : 0);

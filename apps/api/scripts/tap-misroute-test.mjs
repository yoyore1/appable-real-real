// Misrouting detection: every element type should patch only the
// narrowest matching wrapper. "Background" on a Text inside a Card inside
// a View must not paint the outer View. Tests against the live app's
// real source files (read-only in-memory).
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

const COLOR = "#0a84ff";
const BG = "#34c759";

const cases = [
  {
    label: "163 value TEXT color (must stay in Text, not Card wrapper)",
    file: "app/(tabs)/index.tsx",
    msg: `[Tap edit] In the app, find the element with testID "home-stat-total-value" and set the text color of "163" to ${COLOR}. Change only what was tapped.`,
    must: /statNumber.*color.*#0a84ff|<Text testID="home-stat-total-value" style=\{\[styles\.statNumber,/,
    mustNot: [
      /testID="home-stat-total"(?!.*-value).*backgroundColor.*#34c759/s,
      /testID="home-stats".*backgroundColor.*#34c759/s,
    ],
  },
  {
    label: "163 card BACKGROUND (must stay on Card, not on home-stats row)",
    file: "app/(tabs)/index.tsx",
    msg: `[Tap edit] In the app, find the element with testID "home-stat-total" and set the background color to ${BG}. Change only what was tapped.`,
    // Either: patch the home file's <Card …> if it's a static wrapper, OR
    // patch the Card component file. Either way, the outer <View testID="home-stats">
    // row must NOT receive the background color.
    must: /<Card testID="home-stat-total"|<View testID=\{testID\} style=\{\[styles\.card, style, \{ backgroundColor: '#34c759' \}\]/,
    mustNot: [
      /testID="home-stats".*backgroundColor/s,
    ],
    fileMustBe: "src/components/Card.tsx",
  },
  {
    label: "163 box TEXT color on text directly (no anchor)",
    file: "app/(tabs)/index.tsx",
    msg: `[Tap edit] In the app, find the element with testID "home-stat-total-value" and set the text color to ${COLOR}. Change only what was tapped.`,
    must: /<Text testID="home-stat-total-value" style=\{\[styles\.statNumber,/,
    mustNot: [],
  },
  {
    label: "Settings section header color",
    file: "app/(tabs)/settings.tsx",
    msg: `[Tap edit] In the app, find the element with testID "settings-about-header" and set the text color of "About" to ${COLOR}. Change only what was tapped.`,
    must: /<Text testID="settings-about-header"/,
    mustNot: [],
  },
  {
    label: "Add-habit name LABEL color (Text inside View group)",
    file: "app/(stack)/add-habit.tsx",
    msg: `[Tap edit] In the app, find the element with testID "add-habit-name-label" and set the text color of "Habit Name" to ${COLOR}. Change only what was tapped.`,
    must: /<Text testID="add-habit-name-label" style=\{\[styles\.label,/,
    mustNot: [
      // No `backgroundColor` should appear on the name-group View, the screen,
      // or any other container in the patched output.
      /add-habit-name-group[^>]*backgroundColor/s,
    ],
  },
  {
    label: "Home add-habit BUTTON background (Card passthrough, primary branch only)",
    file: "app/(tabs)/index.tsx",
    msg: `[Tap edit] In the app, find the element with testID "home-add-habit" and set the background color to ${BG}. Change only what was tapped.`,
    // AppButton has 3 variants — only the primary branch's `style` array
    // should pick up the new backgroundColor. The secondary/danger Pressables
    // (above the default branch in the source) must be untouched.
    must: /styles\.primary, \{ backgroundColor: '#[0-9a-fA-F]{3,8}' \}|pressedPrimary, \{ backgroundColor: '#[0-9a-fA-F]{3,8}' \}/,
    mustNot: [
      /styles\.textBtn, [^}]*\{ backgroundColor: '#34c759' \}/,
      /styles\.textBtn, [^}]*\{ backgroundColor: '#34c759' \}/,
      /addButtonWrap.*backgroundColor/s,
    ],
    fileMustBe: "src/components/AppButton.tsx",
  },
  {
    label: "Habit name SCOPED color (only h1)",
    file: "app/(tabs)/index.tsx",
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-name" and set the text color of "Morning run" to ${COLOR}. Change only what was tapped.`,
    must: /habit\.id === 'h1' && \{ color: '#0a84ff' \}/,
    mustNot: [/habit\.id === 'h2'/],
  },
  {
    // Regression for the "Custom component with nested JSX child prop" bug.
    // <EmptyState testID="home-empty" icon={<Ionicons name="…" size={…} />} />
    // has a `<` inside the testID-bearing tag's attributes, so a naive regex
    // that uses `[^<]*?` between the tag name and the testID literal fails to
    // capture the tag. The walker must look at the testID literal first and
    // then walk back to the opening `<` of the component tag.
    label: "EmptyState passthrough BG (component with nested JSX child prop)",
    file: "app/(tabs)/index.tsx",
    msg: `[Tap edit] In the app, find the element with testID "home-empty" and set the background color to ${BG}. Change only what was tapped.`,
    must: /<View testID=\{testID\} style=\{\[styles\.wrap, \{ backgroundColor: '#34c759' \}\]/,
    mustNot: [
      // The EmptyState call site in index.tsx must NOT receive the bg.
      /<EmptyState testID="home-empty"[^>]*backgroundColor/s,
    ],
    fileMustBe: "src/components/EmptyState.tsx",
  },
];

let failed = 0;
let total = 0;
for (const c of cases) {
  total++;
  const parsed = parseTapEditRequest(c.msg);
  const result = parsed ? attemptTapEditPatch(parsed, sources) : { ok: false };
  const detail = { label: c.label, ok: false, file: result.ok ? result.file : null, problems: [] };
  if (!result.ok) {
    detail.problems.push("no patch produced");
  } else {
    const errs = syntaxErrors(result.updated);
    if (errs.length) detail.problems.push(`syntax: ${errs[0]}`);
    if (c.fileMustBe && result.file !== c.fileMustBe)
      detail.problems.push(`expected ${c.fileMustBe}, patched ${result.file}`);
    if (c.must && !c.must.test(result.updated))
      detail.problems.push("required pattern not found");
    for (const bad of c.mustNot ?? []) {
      if (bad.test(result.updated)) detail.problems.push("misroute detected");
    }
  }
  detail.ok = detail.problems.length === 0;
  console.log(JSON.stringify(detail));
  if (!detail.ok) failed++;
}
console.log(`${total - failed}/${total} pass`);
console.log(failed === 0 ? "MISROUTE: ALL PASS" : `MISROUTE: ${failed} FAILURES`);
process.exit(failed > 0 ? 1 : 0);

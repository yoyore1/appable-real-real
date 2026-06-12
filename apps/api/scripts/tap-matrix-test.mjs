// Exhaustive tap-to-edit matrix over the REAL app's sources (in-memory, no writes).
// Every element type × {text color, background, font weight}: must patch, stay
// valid TSX, stay scoped (no theme-token or wrapper misroutes), and conditional
// patches must target only the tapped item.
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
console.error(`# source files: ${sources.size}; includes add-habit: ${sources.has("app/(stack)/add-habit.tsx")}`);

function syntaxErrors(code) {
  const sf = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return (sf.parseDiagnostics ?? []).map((d) =>
    typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
  );
}

const msg = {
  color: (id, anchor, c) =>
    anchor
      ? `[Tap edit] In the app, find the element with testID "${id}" and set the text color of "${anchor}" to ${c}. Change only what was tapped.`
      : `[Tap edit] In the app, find the element with testID "${id}" and set the text color to ${c}. Change only what was tapped.`,
  bg: (id, c) =>
    `[Tap edit] In the app, find the element with testID "${id}" and set the background color to ${c}. Change only what was tapped.`,
  screenBg: (id, c) =>
    `[Tap edit] In the app, find the element with testID "${id}" and set the screen background color to ${c}. Change only what was tapped.`,
  bold: (id, anchor) =>
    anchor
      ? `[Tap edit] In the app, find the element with testID "${id}" and set the font weight of "${anchor}" to bold. Change only what was tapped.`
      : `[Tap edit] In the app, find the element with testID "${id}" and set the font weight to bold. Change only what was tapped.`,
};

// kind: text = color+bold apply; container = bg applies; screen = screen bg
const elements = [
  // --- home screen: static texts ---
  { id: "home-quick-title", anchor: "Quick Check-In", kinds: ["text"] },
  { id: "home-stat-today-label", anchor: "Today", kinds: ["text"] },
  { id: "home-stat-today-value", anchor: null, kinds: ["text"] },
  { id: "home-view-all-text", anchor: "View all habits", kinds: ["text"] },
  // --- home screen: containers ---
  { id: "home-stat-today", anchor: null, kinds: ["container"] },
  { id: "home-view-all", anchor: null, kinds: ["container"] },
  // --- home screen: mapped list (template testIDs, h1 = real habit) ---
  { id: "home-habit-h1-name", anchor: "Morning run", kinds: ["text"], scopedTo: "h1" },
  { id: "home-habit-h1-streak", anchor: null, kinds: ["text"], scopedTo: "h1" },
  { id: "home-habit-h1", anchor: null, kinds: ["container"], scopedTo: "h1" },
  // --- buttons (component passthrough: AppButton) ---
  { id: "home-add-habit", anchor: null, kinds: ["container"], expectFile: "src/components/AppButton.tsx" },
  { id: "home-add-habit-label", anchor: "Add New Habit", kinds: ["text"], expectFile: "src/components/AppButton.tsx" },
  // direct Pressable button (not AppButton) on the add-habit screen
  { id: "add-habit-save", anchor: null, kinds: ["container"] },
  { id: "add-habit-save-label", anchor: "Save Habit", kinds: ["text"] },
  // --- habits screen: mapped rows ---
  { id: "habit-h1-name", anchor: "Morning run", kinds: ["text"], scopedTo: "h1" },
  { id: "habit-h1-desc", anchor: null, kinds: ["text"], scopedTo: "h1" },
  { id: "habit-row-h1", anchor: null, kinds: ["container"], scopedTo: "h1" },
  // --- add habit screen: static texts ---
  { id: "add-habit-name-label", anchor: "Habit Name", kinds: ["text"] },
  { id: "add-habit-tips-title", anchor: "Tips for good habits", kinds: ["text"] },
  // --- settings/sections ---
  { id: "settings-about-header", anchor: "About", kinds: ["text"] },
  // --- screens ---
  { id: "home-screen", anchor: null, kinds: ["screen"] },
];

const COLOR = "#a1b2c3";
const BG = "#0d1e2f";

let failed = 0;
let total = 0;

function runCase(label, message, { expectFile, scopedTo, allowTokens } = {}) {
  total++;
  const parsed = parseTapEditRequest(message);
  const result = parsed ? attemptTapEditPatch(parsed, sources) : { ok: false };
  let ok = Boolean(result.ok);
  const detail = { label, ok: false, file: result.ok ? result.file : null, problems: [] };

  if (!result.ok) {
    detail.problems.push("no patch produced");
  } else {
    const errs = syntaxErrors(result.updated);
    if (errs.length) detail.problems.push(`syntax: ${errs[0]}`);
    if (!allowTokens && result.file.includes("tokens.ts"))
      detail.problems.push("misroute: patched theme tokens");
    if (expectFile && result.file !== expectFile)
      detail.problems.push(`expected ${expectFile}, patched ${result.file}`);
    if (/style=\{\[\(/.test(result.updated))
      detail.problems.push("function style wrapped in array");
    if (scopedTo) {
      const re = new RegExp(`===\\s*['"]${scopedTo}['"]`);
      if (!re.test(result.updated)) detail.problems.push(`not scoped to ${scopedTo}`);
    }
    // wrapper misroute: full-width layout wrappers must never be painted
    if (/addButtonWrap[^\n]*backgroundColor/.test(result.updated))
      detail.problems.push("misroute: painted wrapper view");
    ok = detail.problems.length === 0;
  }
  detail.ok = ok;
  console.log(JSON.stringify(detail));
  if (!ok) failed++;
}

for (const el of elements) {
  if (el.kinds.includes("text")) {
    runCase(`${el.id} :: color`, msg.color(el.id, el.anchor, COLOR), el);
    runCase(`${el.id} :: bold`, msg.bold(el.id, el.anchor), el);
  }
  if (el.kinds.includes("container")) {
    runCase(`${el.id} :: background`, msg.bg(el.id, BG), el);
  }
  if (el.kinds.includes("screen")) {
    runCase(`${el.id} :: screen bg`, msg.screenBg(el.id, BG), { ...el, allowTokens: true });
  }
}

console.log(`${total - failed}/${total} pass`);
console.log(failed === 0 ? "MATRIX: ALL PASS" : `MATRIX: ${failed} FAILURES`);
process.exit(failed > 0 ? 1 : 0);

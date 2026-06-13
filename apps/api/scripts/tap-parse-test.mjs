// tap-parse-test.mjs
// Unit test: ensure parseTapEditRequest handles every variation of the
// `[Tap edit] ...` message that the Build UI generates, plus several
// malformed inputs that the patcher must safely reject.
import { parseTapEditRequest } from "../src/agent/tapEdit.ts";

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

function expect(label, msg, expected) {
  const r = parseTapEditRequest(msg);
  if (!r) {
    assert(label, false, { msg, reason: "returned null" });
    return;
  }
  if (expected.testId !== undefined && r.testId !== expected.testId) {
    assert(label, false, { msg, expected: expected.testId, got: r.testId });
    return;
  }
  if (expected.changesLength !== undefined && r.changes.length !== expected.changesLength) {
    assert(label, false, {
      msg,
      expectedLen: expected.changesLength,
      gotLen: r.changes.length,
      got: r.changes,
    });
    return;
  }
  if (expected.firstChangeType !== undefined && r.changes[0]?.type !== expected.firstChangeType) {
    assert(label, false, {
      msg,
      expectedType: expected.firstChangeType,
      gotType: r.changes[0]?.type,
    });
    return;
  }
  if (expected.firstChangeValue !== undefined && r.changes[0]?.value !== expected.firstChangeValue) {
    assert(label, false, {
      msg,
      expectedValue: expected.firstChangeValue,
      gotValue: r.changes[0]?.value,
    });
    return;
  }
  assert(label, true);
}

// --- color edits ---
expect(
  "color: text color on element with testID",
  `[Tap edit] In the app, find the element with testID "home-stat-best-value" and set the text color to #ff5500. Change only what was tapped.`,
  { testId: "home-stat-best-value", changesLength: 1, firstChangeType: "color", firstChangeValue: "#ff5500" },
);

expect(
  "color: text color of an anchor",
  `[Tap edit] In the app, find the element with testID "home-stat-best-value" and set the text color of "163" to #00aa88. Change only what was tapped.`,
  { testId: "home-stat-best-value", changesLength: 1, firstChangeType: "color" },
);

// --- background edits ---
expect(
  "bg: card background on element with testID",
  `[Tap edit] In the app, find the element with testID "home-stat-best" and set the background color to #112233. Change only what was tapped.`,
  { testId: "home-stat-best", changesLength: 1, firstChangeType: "background", firstChangeValue: "#112233" },
);

expect(
  "bg: anchor-scoped (container for X)",
  `[Tap edit] In the app, find the element with testID "home-habit-h1" and set the background color of the container for "Morning run" to #445566. Change only what was tapped.`,
  { testId: "home-habit-h1", changesLength: 1, firstChangeType: "background" },
);

expect(
  "bg: screen background",
  `[Tap edit] In the app, find the element with testID "home-screen" and set the screen background color to #fafafa. Change only what was tapped.`,
  { testId: "home-screen", changesLength: 1, firstChangeType: "background" },
);

// --- text edits ---
expect(
  "text: replace text",
  `[Tap edit] In the app, find the element with testID "home-quick-title" and replace the text "Quick Check-In" with "Daily Check-In". Change only what was tapped.`,
  { testId: "home-quick-title", changesLength: 1, firstChangeType: "text" },
);

expect(
  "text: set text to (no old value)",
  `[Tap edit] In the app, find the element with testID "home-welcome" and set the text to "Welcome back". Change only what was tapped.`,
  { testId: "home-welcome", changesLength: 1, firstChangeType: "text" },
);

// --- font weight / family ---
expect(
  "font weight: bold",
  `[Tap edit] In the app, find the element with testID "home-stat-best-value" and set the font weight to bold. Change only what was tapped.`,
  { testId: "home-stat-best-value", changesLength: 1, firstChangeType: "fontWeight", firstChangeValue: "700" },
);

expect(
  "font weight: normal",
  `[Tap edit] In the app, find the element with testID "home-stat-best-value" and set the font weight to normal. Change only what was tapped.`,
  { testId: "home-stat-best-value", changesLength: 1, firstChangeType: "fontWeight", firstChangeValue: "400" },
);

expect(
  "font weight: anchor-scoped",
  `[Tap edit] In the app, find the element with testID "home-stat-best-value" and set the font weight of "163" to bold. Change only what was tapped.`,
  { testId: "home-stat-best-value", changesLength: 1, firstChangeType: "fontWeight" },
);

// --- icon removal ---
expect(
  "remove icon: scoped",
  `[Tap edit] In the app, find the element with testID "home-empty" and remove the icon from the container for "Browse Recipes". Change only what was tapped.`,
  { testId: "home-empty", changesLength: 1, firstChangeType: "removeIcon" },
);

// --- multi-change compound messages ---
expect(
  "multi: color + bg",
  `[Tap edit] In the app, find the element with testID "home-stat-best" and set the text color to #ff5500; set the background color to #112233. Change only what was tapped.`,
  { testId: "home-stat-best", changesLength: 2 },
);

// --- malformed inputs (must return null) ---
{
  const r = parseTapEditRequest("not a tap edit message");
  assert("malformed: not a tap edit message returns null", r === null);
}
{
  const r = parseTapEditRequest("[Tap edit] missing rest");
  assert("malformed: too short returns null", r === null);
}
{
  const r = parseTapEditRequest(
    `[Tap edit] In the app, find the element with testID "x" and do something weird. Change only what was tapped.`,
  );
  assert(
    "malformed: unknown change verb returns null or zero changes",
    r === null || r.changes.length === 0,
  );
}

// --- single-quoted testIDs (alternate format) ---
expect(
  "color: single-quoted testID",
  `[Tap edit] In the app, find the element with testID 'home-stat-best-value' and set the text color to #ff5500. Change only what was tapped.`,
  { testId: "home-stat-best-value", changesLength: 1, firstChangeType: "color" },
);

console.log(`${total - failed}/${total} pass`);
console.log(failed === 0 ? "PARSE: ALL PASS" : `PARSE: ${failed} FAILURES`);
process.exit(failed > 0 ? 1 : 0);

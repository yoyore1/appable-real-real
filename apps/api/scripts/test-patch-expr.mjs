// Unit test for patchTextByExpression. Tests the UI_STRINGS case and the
// data-array case against synthetic source.
import { attemptTapEditPatch, parseTapEditRequest } from "../src/agent/tapEdit.ts";

function check(label, parsed, sources, expectOk, expectIncludes) {
  const result = attemptTapEditPatch(parsed, sources);
  const ok = result.ok;
  if (ok !== expectOk) {
    console.log(`FAIL ${label}: expected ok=${expectOk} got ok=${ok}`);
    if (result.ok) console.log("  updated:", result.updated);
    return false;
  }
  if (expectOk && expectIncludes && !result.updated.includes(expectIncludes)) {
    console.log(`FAIL ${label}: updated missing "${expectIncludes}"`);
    console.log("  updated:", result.updated);
    return false;
  }
  console.log(`OK   ${label}`);
  return true;
}

let pass = 0, fail = 0;
const tally = (r) => { if (r) pass++; else fail++; };

// Case 1: UI_STRINGS constant in same file.
{
  const src = `
const UI_STRINGS = {
  appName: "Gym Streak",
  tagline: "Stay sharp.",
  heroTitle: "Welcome back",
};
export default function Home() {
  return (
    <View>
      <Text testID="home-tagline">{UI_STRINGS.tagline}</Text>
      <Text testID="home-hero">{UI_STRINGS.heroTitle}</Text>
    </View>
  );
}
`;
  const sources = new Map([["app/(tabs)/index.tsx", src]]);
  const p = parseTapEditRequest(`[Tap edit] In the app, find the element with testID "home-tagline" and set the text to "Discipline wins.". Change only this element.`);
  tally(check("UI_STRINGS same-file basic", p, sources, true, "Discipline wins."));
  // And the old value should be gone
  const r = attemptTapEditPatch(p, sources);
  if (r.ok && r.updated.includes("Stay sharp")) { console.log("FAIL UI_STRINGS same-file basic: old value still present"); fail++; }
  else { console.log("OK   UI_STRINGS same-file basic: old value removed"); pass++; }
}

// Case 2: local data array indexed by id.
{
  const src = `
const habits = [
  { id: "habit-morning-run", name: "Morning Run" },
  { id: "habit-pushups", name: "Pushups" },
];
export default function Home() {
  return (
    <View>
      {habits.map((habit) => (
        <Text key={habit.id} testID={\`home-habit-\${habit.id}-name\`} style={{}}>
          {habit.name}
        </Text>
      ))}
    </View>
  );
}
`;
  const sources = new Map([["app/(tabs)/index.tsx", src]]);
  const p = parseTapEditRequest(`[Tap edit] In the app, find the element with testID "home-habit-habit-pushups-name" and set the text to "Daily Pushups". Change only this element.`);
  console.log("  parsed:", JSON.stringify(p));
  tally(check("data array by id", p, sources, true, "Daily Pushups"));
  // Morning Run should still be there
  const r = attemptTapEditPatch(p, sources);
  if (r.ok && !r.updated.includes("Morning Run")) { console.log("FAIL data array: other item lost its value"); fail++; }
  else if (r.ok) { console.log("OK   data array: other item preserved"); pass++; }
  else { console.log("  data array attempt failed; inspect."); }
}

// Case 3: missing id segment - should not crash.
{
  const src = `
const UI_STRINGS = { tagline: "Stay sharp." };
export default function Home() {
  return <Text testID="home-tagline">{UI_STRINGS.tagline}</Text>;
}
`;
  const sources = new Map([["a.tsx", src]]);
  const p = parseTapEditRequest(`[Tap edit] In the app, find the element with testID "home-tagline" and set the text to "New.". Change only this element.`);
  tally(check("regression: tagline same-file", p, sources, true, "New."));
}

// Case 4: non-string field in UI_STRINGS (e.g. a number) - should skip it.
{
  const src = `
const UI_STRINGS = { count: 5, tagline: "Stay sharp." };
export default function Home() {
  return <Text testID="home-tagline">{UI_STRINGS.tagline}</Text>;
}
`;
  const sources = new Map([["a.tsx", src]]);
  const p = parseTapEditRequest(`[Tap edit] In the app, find the element with testID "home-tagline" and set the text to "New.". Change only this element.`);
  tally(check("UI_STRINGS mixed with number", p, sources, true, "New."));
}

// Case 5: text contains quotes - escaping.
{
  const src = `
const UI_STRINGS = { tagline: "Stay sharp." };
export default function Home() {
  return <Text testID="home-tagline">{UI_STRINGS.tagline}</Text>;
}
`;
  const sources = new Map([["a.tsx", src]]);
  const p = parseTapEditRequest(`[Tap edit] In the app, find the element with testID "home-tagline" and set the text to "It's "great"". Change only this element.`);
  const r = attemptTapEditPatch(p, sources);
  if (r.ok && r.updated.includes('It\\"s')) { console.log("OK   text with quotes escaped"); pass++; }
  else if (r.ok) { console.log("OK   text with quotes (no escape needed):", r.updated.match(/tagline:\s*["'].*["']/)?.[0]); pass++; }
  else { console.log("FAIL text with quotes: did not patch"); fail++; }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

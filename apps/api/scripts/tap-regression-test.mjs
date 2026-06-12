import ts from "typescript";
import { applyTapEditToSource, probeTapEditRequest } from "../src/agent/tapEdit.ts";

/** Patched output must still be valid TSX — regex matches alone hid syntax errors before. */
function syntaxErrors(code) {
  const sf = ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return (sf.parseDiagnostics ?? []).map((d) =>
    typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
  );
}

// --- v2 map-template app (GymStreak shape) ---
const LIST_APP = `
import { Pressable, ScrollView, Text } from "react-native";

export default function HomeScreen() {
  return (
    <ScrollView style={styles.screen} testID="home-screen">
      {habits.map((habit) => (
        <Pressable
          key={habit.id}
          style={styles.card}
          testID={\`home-habit-\${habit.id}-row\`}
        >
          <Text testID={\`home-habit-\${habit.id}-name\`} style={styles.habitName}>
            {habit.name}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
`;

// --- v1-style static app (literals, static testIDs) ---
const STATIC_APP = `
import { Text, View, ScrollView } from "react-native";

export default function HomeScreen() {
  return (
    <ScrollView style={styles.screen} testID="home-screen">
      <Text testID="home-title" style={styles.title}>My Habits</Text>
      <View testID="stat-total-days" style={styles.statCard}>
        <Text testID="stat-total-days-value" style={styles.statValue}>163</Text>
      </View>
    </ScrollView>
  );
}
`;

// --- Real GymStreak shape: two-param map, suffix-less row testID, STRINGS object ---
const GYMSTREAK_APP = `
import { Pressable, Text, View } from "react-native";

export const HOME_STRINGS = {
  quickCheckInTitle: "Quick Check-In",
  done: "Done",
} as const;

export default function HomeRoute() {
  return (
    <Screen testID="home-screen" title="Home" largeTitle scroll>
      <Text testID="home-quick-title" style={styles.sectionTitle}>{HOME_STRINGS.quickCheckInTitle}</Text>
      {quickHabits.map((habit, index) => {
        return (
          <Pressable
            key={habit.id}
            testID={\`home-habit-\${habit.id}\`}
            onPress={() => handleCheckIn(habit.id)}
            style={({ pressed }) => [styles.habitRow, pressed && styles.pressed]}
          >
            <View style={styles.habitInfo}>
              <Text testID={\`home-habit-\${habit.id}-name\`} style={styles.habitName} numberOfLines={1}>
                {habit.name}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </Screen>
  );
}
`;

const cases = [
  // ---- Real GymStreak shape ----
  {
    label: "GYM: color on habit name (two-param map)",
    src: GYMSTREAK_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-name" and set the text color of "Morni" to #ff5500. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ color: '#ff5500' \}/,
    rejectShared: null,
  },
  {
    label: "GYM: bg on suffix-less row testID",
    src: GYMSTREAK_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1" and set the background color to #112233. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ backgroundColor: '#112233' \}/,
    rejectShared: /styles\.habitRow,\s*\{ backgroundColor/,
  },
  {
    // RN ignores a function nested inside a style array, so the conditional
    // MUST land inside the arrow's returned array, not wrap the function.
    label: "GYM: bg goes INSIDE function style array",
    src: GYMSTREAK_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1" and set the background color to #112233. Change only what was tapped.`,
    expect: /=>\s*\[styles\.habitRow, pressed && styles\.pressed, habit\.id === 'h1' && \{ backgroundColor: '#112233' \}\]/,
    rejectShared: /style=\{\[\(/,
  },
  {
    label: "GYM: font weight on habit name (anchored)",
    src: GYMSTREAK_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-name" and set the font weight of "Morni" to bold. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ fontWeight: '700' \}/,
    rejectShared: /habitName, \{ fontWeight/,
  },
  {
    label: "GYM: title color stays inline (anchored)",
    src: GYMSTREAK_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-quick-title" and set the text color of "Quick Check-In" to #00ff88. Change only what was tapped.`,
    expect: /color: '#00ff88'/,
    rejectShared: null,
  },
  {
    label: "GYM: rename HOME_STRINGS member",
    src: GYMSTREAK_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-quick-title" and replace the text "Quick Check-In" with "Daily Check". Change only what was tapped.`,
    expect: /quickCheckInTitle: "Daily Check"/,
    rejectShared: null,
  },
  // ---- Anchored messages (what Build UI actually sends) ----
  {
    label: "ANCHORED color on list item",
    src: LIST_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-name" and set the text color of "Morni" to #ff5500. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ color: '#ff5500' \}/,
    rejectShared: /habitName,\s*\{ color/,
  },
  {
    label: "ANCHORED bg on list item container",
    src: LIST_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-row" and set the background color of the container for "Morni" to #112233. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ backgroundColor: '#112233' \}/,
    rejectShared: null,
  },
  {
    label: "plain color msg on list item",
    src: LIST_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-name" and set the text color to #ff5500. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ color: '#ff5500' \}/,
    rejectShared: null,
  },
  // ---- Static app must keep working (v1 behaviour) ----
  {
    label: "static title text replace",
    src: STATIC_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-title" and replace the text "My Habits" with "Habit Hub". Change only what was tapped.`,
    expect: /Habit Hub/,
    rejectShared: null,
  },
  {
    label: "ANCHORED static title color",
    src: STATIC_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-title" and set the text color of "My Habits" to #00aa55. Change only what was tapped.`,
    expect: /color: '#00aa55'/,
    rejectShared: null,
  },
  {
    label: "static stat value color (no anchor)",
    src: STATIC_APP,
    msg: `[Tap edit] In the app, find the element with testID "stat-total-days-value" and set the text color to #ff0000. Change only what was tapped.`,
    expect: /color: '#ff0000'/,
    rejectShared: null,
  },
  {
    label: "static card bg",
    src: STATIC_APP,
    msg: `[Tap edit] In the app, find the element with testID "stat-total-days" and set the background color to #222222. Change only what was tapped.`,
    expect: /backgroundColor: '#222222'/,
    rejectShared: null,
  },
  {
    label: "screen bg",
    src: STATIC_APP,
    msg: `[Tap edit] In the app, find the element with testID "home-screen" and set the screen background color to #aabbcc. Change only what was tapped.`,
    expect: /backgroundColor:\s*['"]#aabbcc['"]/,
    rejectShared: null,
  },
];

let failed = 0;
for (const { label, src, msg, expect, rejectShared } of cases) {
  const sources = new Map([["app/(tabs)/index.tsx", src]]);
  const probe = probeTapEditRequest(msg, sources);
  const patched = applyTapEditToSource(src, msg);
  const synErrs = patched ? syntaxErrors(patched) : [];
  let ok = probe.ok && Boolean(patched) && expect.test(patched ?? "") && synErrs.length === 0;
  if (ok && rejectShared && rejectShared.test(patched ?? "")) ok = false;
  console.log(
    JSON.stringify({ label, probeOk: probe.ok, patched: Boolean(patched), syntaxOk: synErrs.length === 0, ok }),
  );
  if (!ok) {
    failed++;
    if (synErrs.length) console.log("--- syntax errors ---\n" + synErrs.slice(0, 3).join("\n"));
    if (patched) console.log("--- patched output ---\n" + patched.slice(0, 800));
  }
}

console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
process.exit(failed > 0 ? 1 : 0);

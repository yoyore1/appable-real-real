import { applyTapEditToSource } from "../src/agent/tapEdit.ts";

const sample = `import { StyleSheet, View, Text, Pressable } from "react-native";

const DAYS = ["Mon", "Tue", "Wed"];

export function Home() {
  return (
    <View testID="home-screen" style={styles.screen}>
      <Text testID="home-title">{"Hello, Chef!"}</Text>
      <Text testID="day-hint">{"Tap to plan"}</Text>
      {DAYS.map((day) => (
        <Pressable key={day} style={styles.dayCard} testID={\`week-day-\${day}\`}>
          <Text testID={\`week-day-label-\${day}\`}>{day}</Text>
          <Text testID={\`week-day-hint-\${day}\`}>{"Tap to plan"}</Text>
        </Pressable>
      ))}
      <Pressable testID="browse-recipes">
        <Text testID="browse-icon">{"📖"}</Text>
        <Text testID="browse-label">{"Browse Recipes"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  dayCard: { padding: 8 },
});
`;

const cases = [
  {
    name: "clear static hint",
    msg: '[Tap edit] In the app, find the element with testID "day-hint" and replace the text "Tap to plan" with "". Change only what was tapped.',
    ok: (f) => f.includes('<Text testID="day-hint">{""}</Text>'),
  },
  {
    name: "rename browse label",
    msg: '[Tap edit] In the app, find the element with testID "browse-label" and replace the text "Browse Recipes" with "Find Recipes". Change only what was tapped.',
    ok: (f) => f.includes("Find Recipes") && !f.includes("Browse Recipes"),
  },
  {
    name: "clear mapped Wed hint only",
    msg: '[Tap edit] In the app, find the element with testID "week-day-hint-Wed" and replace the text "Tap to plan" with "". Change only what was tapped.',
    ok: (f) =>
      f.includes("day === 'Wed' ? \"\" : \"Tap to plan\"") &&
      f.includes('<Text testID="day-hint">{"Tap to plan"}</Text>'),
  },
  {
    name: "rename Wed label only",
    msg: '[Tap edit] In the app, find the element with testID "week-day-label-Wed" and replace the text "Wed" with "Weds". Change only what was tapped.',
    ok: (f) => f.includes("day === 'Wed' ? \"Weds\" : day"),
  },
  {
    name: "remove browse icon",
    msg: '[Tap edit] In the app, find the element with testID "browse-label" and remove the icon from the container for "Browse Recipes". Change only what was tapped.',
    ok: (f) => !f.includes("browse-icon") && !f.includes("📖"),
  },
];

let failed = 0;
for (const c of cases) {
  const out = applyTapEditToSource(sample, c.msg);
  const pass = out && c.ok(out);
  console.log(pass ? "PASS" : "FAIL", c.name);
  if (!pass) {
    failed++;
    console.log(out?.slice(0, 900) ?? "null");
  }
}

process.exit(failed > 0 ? 1 : 0);

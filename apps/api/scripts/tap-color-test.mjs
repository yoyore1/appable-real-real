import { applyTapEditToSource, probeTapEditRequest } from "../src/agent/tapEdit.ts";

const SAMPLE = `
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

const sources = new Map([["app/(tabs)/index.tsx", SAMPLE]]);

const cases = [
  {
    label: "text color on habit name",
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-name" and set the text color to #ff5500. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ color: '#ff5500' \}/,
  },
  {
    label: "card background on habit row",
    msg: `[Tap edit] In the app, find the element with testID "home-habit-h1-row" and set the background color to #112233. Change only what was tapped.`,
    expect: /habit\.id === 'h1' && \{ backgroundColor: '#112233' \}/,
  },
  {
    label: "screen background",
    msg: `[Tap edit] In the app, find the element with testID "home-screen" and set the screen background color to #aabbcc. Change only what was tapped.`,
    expect: /backgroundColor:\s*['"]#aabbcc['"]/,
  },
];

let failed = 0;
for (const { label, msg, expect } of cases) {
  const probe = probeTapEditRequest(msg, sources);
  const patched = applyTapEditToSource(SAMPLE, msg);
  const ok = probe.ok && patched && expect.test(patched);
  console.log(JSON.stringify({ label, probeOk: probe.ok, patched: Boolean(patched), ok }));
  if (!ok) {
    failed++;
    if (patched) console.log(patched.slice(0, 600));
  }
}

process.exit(failed > 0 ? 1 : 0);

import { applyTapEditToSource } from "../src/agent/tapEdit.ts";

const SAMPLE = `
export default function HomeScreen() {
  return (
    <>
      {habits.map((habit) => (
        <Text testID={\`home-habit-\${habit.id}-name\`} style={styles.habitName}>
          {habit.name}
        </Text>
      ))}
    </>
  );
}
`;

const STORAGE = `
export const SEED_HABITS = [
  { id: "h1", name: "Morning run", streak: 0 },
];
`;

const msg =
  '[Tap edit] In the app, find the element with testID "home-habit-h1-name" and replace the text "Morning" with "Morni". Change only what was tapped.';

const indexPatched = applyTapEditToSource(SAMPLE, msg);
const storagePatched = applyTapEditToSource(STORAGE, msg);

console.log("index unchanged (data-driven):", indexPatched === SAMPLE);
console.log("storage patched:", storagePatched?.includes('name: "Morni"') ?? false);

process.exit(
  indexPatched === SAMPLE && storagePatched?.includes('name: "Morni"') ? 0 : 1,
);

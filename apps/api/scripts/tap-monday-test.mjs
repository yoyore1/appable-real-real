import { applyTapEditToSource } from "../src/agent/tapEdit.ts";
import { readProjectFile } from "../src/orchestrator.ts";

const mealPlanCard = `export const MealPlanCard = ({ day, date, meals, onPress }) => {
  const dayTextStyle = day === 'Mon' ? [styles.day, { color: '#ff5500' }] : styles.day;
  return (
    <TouchableOpacity onPress={onPress} testID={\`meal-plan-\${day.toLowerCase()}\`}>
      <View style={styles.header}>
        <Text style={dayTextStyle}>{day === 'Mon' ? "Monday" : day}</Text>
        <Text style={styles.date}>{date}</Text>
      </View>
    </TouchableOpacity>
  );
};`;

const msg =
  '[Tap edit] In the app, find the element with testID "meal-plan-mon" and replace the text "Monday" with "Mon". Change only what was tapped.';

const out = applyTapEditToSource(mealPlanCard, msg);
console.log(out ? "PASS" : "FAIL");
if (out) {
  console.log(out.includes('"Monday"') ? "still has Monday" : "Monday removed");
  console.log(out.match(/day === 'Mon'/)?.[0] ?? "no ternary");
}

const pid = process.env.PROJECT_ID ?? "cmq8w9jk20001tlp0m4sbhx2m";
try {
  const live = await readProjectFile(pid, "src/components/MealPlanCard.tsx");
  const liveOut = applyTapEditToSource(live, msg);
  console.log(liveOut ? "PASS live MealPlanCard" : "FAIL live MealPlanCard");
} catch (e) {
  console.log("SKIP live", e.message);
}

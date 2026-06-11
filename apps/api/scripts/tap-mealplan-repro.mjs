import { applyTapEditToSource } from "../src/agent/tapEdit.ts";

const mealPlanCard = `import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface MealPlanCardProps {
  day: string;
  date: string;
  meals: { breakfast?: string; lunch?: string; dinner?: string };
  onPress: () => void;
}

export const MealPlanCard: React.FC<MealPlanCardProps> = ({ day, date, meals, onPress }) => {
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} testID={\`meal-plan-\${day.toLowerCase()}\`}>
      <View style={styles.header}>
        <Text style={styles.day}>{day}</Text>
        <Text style={styles.date}>{date}</Text>
      </View>
      <View style={styles.meals}>
        {!meals.breakfast && !meals.lunch && !meals.dinner && (
          <Text style={styles.empty}>Tap to plan</Text>
        )}
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { fontSize: 18, fontWeight: '700' },
  date: { fontSize: 14, color: '#888' },
  meals: { gap: 4 },
  empty: { fontSize: 14, color: '#AAA', fontStyle: 'italic' },
});
`;

function isValidTsx(src) {
  if (/Monss\d+|Tuesay\d+|'[A-Za-z]+\d+\s*$/m.test(src)) return false;
  if (/day === '[^'\n]+$/m.test(src)) return false;
  const quotes = (src.match(/'/g) ?? []).length;
  if (quotes % 2 !== 0) return false;
  return true;
}

let failed = 0;
function check(name, ok, snippet) {
  if (ok) {
    console.log("PASS", name);
    return;
  }
  failed++;
  console.log("FAIL", name);
  console.log(snippet?.slice(0, 1200) ?? "null");
}

// Sequential background colors — must be per-day cardStyle, not one color for all
let seq = mealPlanCard;
for (const [id, color] of [
  ["meal-plan-mon", "#d32222"],
  ["meal-plan-tue", "#e22222"],
  ["meal-plan-mon", "#111111"],
]) {
  const msg = `[Tap edit] In the app, find the element with testID "${id}" and set the background color to ${color}. Change only what was tapped.`;
  seq = applyTapEditToSource(seq, msg);
  if (!seq || !isValidTsx(seq)) {
    check(`bg ${id}`, false, seq);
    process.exit(1);
  }
}
check(
  "sequential bg uses per-day cardStyle",
  seq.includes("const cardStyle") &&
    seq.includes("day === 'Mon'") &&
    seq.includes("day === 'Tue'") &&
    seq.includes("style={cardStyle}") &&
    !seq.includes("style={[styles.card, { backgroundColor: '#111111' }]}"),
  seq,
);

// Text edit on Mon label — must NOT corrupt cardStyle ternary
const withBg = seq;
const textMsg =
  '[Tap edit] In the app, find the element with testID "meal-plan-mon" and replace the text "Mon" with "Monday". Change only what was tapped.';
const textOut = applyTapEditToSource(withBg, textMsg);
check(
  "rename Mon label without corrupting cardStyle",
  textOut &&
    isValidTsx(textOut) &&
    textOut.includes("day === 'Mon' ? \"Monday\" : day") &&
    !textOut.includes("Monss") &&
    !textOut.includes("Monday' ? [styles.card"),
  textOut,
);

// Simulated typo edit that used to corrupt (global replace)
const typoMsg =
  '[Tap edit] In the app, find the element with testID "meal-plan-mon" and replace the text "Mon" with "Monss376". Change only what was tapped.';
const typoOut = applyTapEditToSource(withBg, typoMsg);
check(
  "typo Mon text stays scoped",
  typoOut &&
    typoOut.includes(`day === 'Mon' ? "Monss376" : day`) &&
    !typoOut.includes("Monss376' ? [") &&
    typoOut.includes("const cardStyle"),
  typoOut,
);

// Multi-line cardStyle (Prettier-style) — second edit must not corrupt the ternary
const multiLineCard = mealPlanCard.replace(
  "style={styles.card}",
  "style={cardStyle}",
).replace(
  "return (",
  `const cardStyle =
    day === 'Mon'
      ? [styles.card, { backgroundColor: '#d32222' }]
      : day === 'Tue'
        ? [styles.card, { backgroundColor: '#e22222' }]
        : styles.card;

  return (`,
);
const multiOut = applyTapEditToSource(
  multiLineCard,
  '[Tap edit] In the app, find the element with testID "meal-plan-mon" and set the background color of the container for "Mon" to #aabbcc. Change only what was tapped.',
);
check(
  "multiline cardStyle update keeps valid ternary",
  multiOut &&
    isValidTsx(multiOut) &&
    multiOut.includes("day === 'Mon'") &&
    multiOut.includes("#aabbcc") &&
    multiOut.includes("day === 'Tue'") &&
    !multiOut.includes("Monss"),
  multiOut,
);

// Text color on day label — must use per-day dayTextStyle, not patch the card box
let colorSeq = mealPlanCard;
for (const [id, label, hex] of [
  ["meal-plan-mon", "Mon", "#ff5500"],
  ["meal-plan-tue", "Tue", "#00aa88"],
  ["meal-plan-mon", "Mon", "#112233"],
]) {
  const msg = `[Tap edit] In the app, find the element with testID "${id}" and set the text color of "${label}" to ${hex}. Change only what was tapped.`;
  colorSeq = applyTapEditToSource(colorSeq, msg);
  if (!colorSeq || !isValidTsx(colorSeq)) {
    check(`text color ${id} ${hex}`, false, colorSeq);
    process.exit(1);
  }
}
check(
  "sequential text color uses per-day dayTextStyle",
  colorSeq.includes("const dayTextStyle") &&
    colorSeq.includes("style={dayTextStyle}") &&
    colorSeq.includes("color: '#112233'") &&
    colorSeq.includes("color: '#00aa88'") &&
    colorSeq.includes("day === 'Mon'") &&
    colorSeq.includes("day === 'Tue'") &&
    !colorSeq.includes("TouchableOpacity style={[") &&
    !/<TouchableOpacity[^>]*color:/.test(colorSeq),
  colorSeq,
);

// Text color with existing multiline cardStyle must not corrupt either ternary
const multiColorOut = applyTapEditToSource(
  multiLineCard,
  '[Tap edit] In the app, find the element with testID "meal-plan-mon" and set the text color of "Mon" to #ff5500. Change only what was tapped.',
);
check(
  "text color with multiline cardStyle stays valid",
  multiColorOut &&
    isValidTsx(multiColorOut) &&
    multiColorOut.includes("const dayTextStyle") &&
    multiColorOut.includes("color: '#ff5500'") &&
    multiColorOut.includes("const cardStyle") &&
    multiColorOut.includes("backgroundColor: '#d32222'"),
  multiColorOut,
);

// Live-shaped file: cardStyle + Monday ternary + dayTextStyle already present
const liveShaped = `import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

export const MealPlanCard = ({ day, date, meals, onPress }) => {
  const cardStyle =
    day === 'Mon'
      ? [styles.card, { backgroundColor: '#d32222' }]
      : day === 'Tue'
        ? [styles.card, { backgroundColor: '#e22222' }]
        : styles.card;
  const dayTextStyle = day === 'Mon' ? [styles.day, { color: '#ff5500' }] : styles.day;
  return (
    <TouchableOpacity style={cardStyle} onPress={onPress} testID={\`meal-plan-\${day.toLowerCase()}\`}>
      <View style={styles.header}>
        <Text style={dayTextStyle}>{day === 'Mon' ? "Monday" : day}</Text>
        <Text style={styles.date}>{date}</Text>
      </View>
    </TouchableOpacity>
  );
};
const styles = StyleSheet.create({
  card: { backgroundColor: '#FFF' },
  day: { fontSize: 18, color: '#1A1A1A' },
  date: { fontSize: 14, color: '#888' },
});
`;

const tueColor = applyTapEditToSource(
  liveShaped,
  '[Tap edit] In the app, find the element with testID "meal-plan-tue" and set the text color of "Tue" to #00aa88. Change only what was tapped.',
);
check(
  "tue text color adds to existing dayTextStyle",
  tueColor &&
    isValidTsx(tueColor) &&
    tueColor.includes("day === 'Tue'") &&
    tueColor.includes("color: '#00aa88'") &&
    tueColor.includes("color: '#ff5500'"),
  tueColor,
);

const dateColor = applyTapEditToSource(
  liveShaped,
  '[Tap edit] In the app, find the element with testID "meal-plan-mon" and set the text color of "6/11" to #336699. Change only what was tapped.',
);
check(
  "date text color patches styles.date not day label",
  dateColor &&
    isValidTsx(dateColor) &&
    /styles\.date.*#336699|#336699.*styles\.date/.test(dateColor.replace(/\s+/g, " ")) &&
    !dateColor.includes("dayTextStyle = day === 'Mon' ? [styles.day, { color: '#336699' }]"),
  dateColor,
);

const wedBg = applyTapEditToSource(
  liveShaped,
  '[Tap edit] In the app, find the element with testID "meal-plan-wed" and set the background color of the container for "Wed" to #445566. Change only what was tapped.',
);
check(
  "wed background color on live-shaped card",
  wedBg &&
    isValidTsx(wedBg) &&
    wedBg.includes("day === 'Wed'") &&
    wedBg.includes("backgroundColor: '#445566'"),
  wedBg,
);

process.exit(failed > 0 ? 1 : 0);

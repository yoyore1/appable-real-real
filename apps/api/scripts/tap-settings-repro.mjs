import { execSync } from "node:child_process";
import { applyTapEditToSource, parseTapEditRequest } from "../src/agent/tapEdit.ts";

const src = execSync(
  "docker exec appable-proj-cmq8w9jk20001tlp0m4sbhx2m cat /app/src/screens/SettingsScreen.tsx",
  { encoding: "utf8" },
);

const msgs = [
  {
    name: "text color only",
    msg: `[Tap edit] In the app, find the text element showing "Meal Remin" and set the text color of "Meal Remin" to #ff0000. Change only what was tapped.`,
    hex: "#ff0000",
  },
  {
    name: "bg only",
    msg: `[Tap edit] In the app, find the text element showing "Meal Remin" and set the background color of the container for "Meal Remin" to #eeeeee. Change only what was tapped.`,
    hex: "#eeeeee",
  },
  {
    name: "text + bg combined",
    msg: `[Tap edit] In the app, find the text element showing "Meal Remin" and set the text color of "Meal Remin" to #ff0000; set the background color of the container for "Meal Remin" to #eeeeee. Change only what was tapped.`,
    hex: "#ff0000",
  },
];

let failed = 0;
for (const c of msgs) {
  const parsed = parseTapEditRequest(c.msg);
  const out = applyTapEditToSource(src, c.msg);
  const ok = Boolean(parsed) && Boolean(out) && out !== src && out.includes(c.hex);
  if (!ok) failed++;
  console.log(ok ? "PASS" : "FAIL", c.name);
  if (!ok) {
    console.log("  parsed:", !!parsed, "out:", !!out, "has hex:", out?.includes(c.hex));
    if (out && out !== src) {
      console.log(
        out
          .split("\n")
          .filter((l) => l.includes("Meal Remin") || l.includes("ff0000") || l.includes("eeeeee"))
          .join("\n"),
      );
    }
  } else if (c.name === "text + bg combined") {
    const snippet = out
      .split("\n")
      .slice(48, 56)
      .join("\n");
    console.log("  snippet:\n", snippet);
  }
}

const withTestIds = src.replace(
  /<View style=\{\[\{ backgroundColor:[^}]+\}\]\}>\s*<Text style=\{\[styles\.optionLabel[^\]]*\]\}>Meal Remin<\/Text>/,
  '<View testID="meal-reminder-row">\n              <Text testID="meal-reminder-label" style={styles.optionLabel}>Meal Remin</Text>',
).replace(
  /<View>\s*<Text style=\{styles\.optionLabel\}>Meal Remin<\/Text>/,
  '<View testID="meal-reminder-row">\n              <Text testID="meal-reminder-label" style={styles.optionLabel}>Meal Remin</Text>',
);

const testIdMsg =
  '[Tap edit] In the app, find the element with testID "meal-reminder-row" and set the text color of "Meal Remin" to #336699; set the background color of the container for "Meal Remin" to #ddeeff. Change only what was tapped.';
const testIdOut = applyTapEditToSource(withTestIds, testIdMsg);
const testIdOk =
  testIdOut &&
  testIdOut.includes("meal-reminder-label") &&
  testIdOut.includes("#336699") &&
  testIdOut.includes("#ddeeff");
if (!testIdOk) failed++;
console.log(testIdOk ? "PASS" : "FAIL", "meal reminder with testIDs");

process.exit(failed > 0 ? 1 : 0);

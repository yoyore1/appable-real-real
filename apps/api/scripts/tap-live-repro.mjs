import { execSync } from "node:child_process";
import { applyTapEditToSource, parseTapEditRequest } from "../src/agent/tapEdit.ts";

const pid = "cmq8w9jk20001tlp0m4sbhx2m";
const container = `appable-proj-${pid}`;

function readFile(path) {
  return execSync(`docker exec ${container} cat /app/${path}`, { encoding: "utf8" });
}

const mealPlan = readFile("src/components/MealPlanCard.tsx");
const home = readFile("src/screens/HomeScreen.tsx");

const cases = [
  {
    name: "scoped bg mon (Build.tsx format)",
    file: mealPlan,
    msg: `[Tap edit] In the app, find the element with testID "meal-plan-mon" and set the background color of the container for "Mon" to #aabbcc. Change only what was tapped.`,
  },
  {
    name: "bg mon unscoped",
    file: mealPlan,
    msg: `[Tap edit] In the app, find the element with testID "meal-plan-mon" and set the background color to #aabbcc. Change only what was tapped.`,
  },
  {
    name: "rename Mon label",
    file: mealPlan,
    msg: `[Tap edit] In the app, find the element with testID "meal-plan-mon" and replace the text "Mon" with "Monday". Change only what was tapped.`,
  },
  {
    name: "header bg home-screen (broad testID)",
    file: home,
    msg: `[Tap edit] In the app, find the element with testID "home-screen" and set the background color to #112233. Change only what was tapped.`,
  },
  {
    name: "header bg via card container label (Build.tsx)",
    file: home,
    msg: `[Tap edit] In the app, find the card container for "Hello, Chef!" and set the background color of the container for "Hello, Chef!" to #112233. Change only what was tapped.`,
  },
  {
    name: "wed card bg first time",
    file: mealPlan,
    msg: `[Tap edit] In the app, find the element with testID "meal-plan-wed" and set the background color of the container for "Wed" to #334455. Change only what was tapped.`,
  },
  {
    name: "quick action title",
    file: home,
    msg: `[Tap edit] In the app, find the element with testID "quick-action-ai" and replace the text "AI Suggestio" with "AI Ideas". Change only what was tapped.`,
  },
  {
    name: "mon text color (Build.tsx format)",
    file: mealPlan,
    msg: `[Tap edit] In the app, find the element with testID "meal-plan-mon" and set the text color of "Mon" to #ff5500. Change only what was tapped.`,
  },
];

let failed = 0;
for (const c of cases) {
  const parsed = parseTapEditRequest(c.msg);
  const patched = applyTapEditToSource(c.file, c.msg);
  const ok = Boolean(parsed) && Boolean(patched) && patched !== c.file;
  if (!ok) failed++;
  console.log(ok ? "PASS" : "FAIL", c.name);
  if (!parsed) console.log("  parse: null");
  else console.log("  testId:", parsed.testId, "changes:", parsed.changes.length);
  if (patched && patched !== c.file) {
    const color = c.msg.match(/#[0-9A-Fa-f]{6}/)?.[0];
    if (color && !patched.includes(color)) {
      failed++;
      console.log("  WARN: patch missing color", color);
    }
    const line = patched.split("\n").find((l) => l.includes(color || "cardStyle") || l.includes("backgroundColor") || l.includes("AI Ideas"));
    if (line) console.log("  ->", line.trim().slice(0, 120));
  } else {
    console.log("  patched: no change");
  }
}

process.exit(failed > 0 ? 1 : 0);

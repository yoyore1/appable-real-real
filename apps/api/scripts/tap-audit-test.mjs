import { execSync } from "node:child_process";
import {
  auditFileContent,
  formatTapEditAuditReport,
} from "../src/agent/tapEditAudit.ts";

const goodSample = `export function Settings() {
  return (
    <View>
      <Pressable testID="meal-reminder-row">
        <Text testID="meal-reminder-label">{STRINGS.mealReminder}</Text>
      </Pressable>
    </View>
  );
}`;

const badSample = `export function Settings() {
  return (
    <View>
      <Pressable>
        <Text>Meal Reminder</Text>
      </Pressable>
      {items.map((item) => (
        <Pressable key={item.id}>
          <Text>{item.name}</Text>
        </Pressable>
      ))}
    </View>
  );
}`;

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    failed++;
    console.log("FAIL", name);
  } else {
    console.log("PASS", name);
  }
}

const goodIssues = auditFileContent(goodSample, "src/screens/SettingsScreen.tsx");
assert("good sample has no issues", goodIssues.length === 0);

const badIssues = auditFileContent(badSample, "src/screens/SettingsScreen.tsx");
assert("bad sample finds text-missing-testid", badIssues.some((i) => i.kind === "text-missing-testid"));
assert("bad sample finds pressable-missing-testid in map", badIssues.some((i) => i.kind === "pressable-missing-testid"));
assert("report mentions issue count", formatTapEditAuditReport(badIssues).includes(String(badIssues.length)));

const splitTitleSample = `export function Card({ title }) {
  const parts = title.split("aghetti");
  return (
    <Text testID="recipe-title-1">
      <>
        <Text>{parts[0]}</Text>
        <Text style={{ color: "red" }}>aghetti</Text>
      </>
    </Text>
  );
}`;
const splitIssues = auditFileContent(splitTitleSample, "src/components/RecipeCard.tsx");
assert("detects split title across Text nodes", splitIssues.some((i) => i.kind === "title-split-across-text"));

const dayHackSample = `<Text>{day === 'Mon' ? "Monday" : day}</Text>`;
const dayIssues = auditFileContent(dayHackSample, "src/components/MealPlanCard.tsx");
assert("detects day display hack", dayIssues.some((i) => i.kind === "day-display-hack"));

const pid = process.env.TAP_AUDIT_PROJECT_ID ?? "cmq8w9jk20001tlp0m4sbhx2m";
const container = `appable-proj-${pid}`;
if (process.env.TAP_AUDIT_SKIP_LIVE !== "1") {
  try {
    execSync(`docker inspect ${container}`, { stdio: "ignore" });
    const settings = execSync(`docker exec ${container} cat /app/src/screens/SettingsScreen.tsx`, {
      encoding: "utf8",
    });
    const liveIssues = auditFileContent(settings, "src/screens/SettingsScreen.tsx");
    const mealReminder = liveIssues.filter((i) => i.snippet.includes("Meal") || i.snippet.includes("meal"));
    assert(
      "MealMingle settings: meal reminder has testIDs",
      mealReminder.length === 0,
    );
    if (mealReminder.length > 0) {
      console.log(formatTapEditAuditReport(mealReminder));
    }
  } catch {
    console.log("SKIP live MealMingle audit (container not running)");
  }
}

process.exit(failed > 0 ? 1 : 0);

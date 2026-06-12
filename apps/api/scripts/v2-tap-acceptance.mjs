/**
 * Phase 1 tap-to-edit acceptance against a live v2 (Expo Router) project container.
 * Usage: pnpm --filter @appable/api exec tsx scripts/v2-tap-acceptance.mjs [projectId]
 */
import { execSync } from "node:child_process";
import { tryTapEditPatch } from "../src/agent/tapEdit.ts";
import { readProjectFile } from "../src/orchestrator.ts";

const projectId = process.argv[2] ?? "cmqary0wg0005tla4lxtrgqbj";
const container = `appable-proj-${projectId}`;

function dockerCat(path) {
  return execSync(`docker exec ${container} cat /app/${path}`, { encoding: "utf8" });
}

async function runCase(name, msg, verify) {
  const result = await tryTapEditPatch(projectId, msg);
  if (!result.ok) {
    console.log("FAIL", name, "- patch returned false");
    return false;
  }
  console.log("  patched", result.file, "-", result.summary);
  try {
    const pass = await verify(result.file);
    console.log(pass ? "PASS" : "FAIL", name);
    return pass;
  } catch (err) {
    console.log("FAIL", name, "-", err instanceof Error ? err.message : err);
    return false;
  }
}

async function main() {
  try {
    execSync(`docker inspect ${container}`, { stdio: "ignore" });
  } catch {
    console.error(`Container ${container} not found. Wake the project first.`);
    process.exit(1);
  }

  let failed = 0;

  // Add a card for card-bg test before other patches
  const indexPath = "app/(tabs)/index.tsx";
  let index = await readProjectFile(projectId, indexPath);
  if (!index.includes('testID="home-card"')) {
    index = index.replace(
      'import { Text } from "react-native";',
      'import { Text, View } from "react-native";',
    );
    index = index.replace(
      "      <Text testID=\"home-welcome\">",
      `      <View testID="home-card" style={{ backgroundColor: "#ffffff", padding: 16, borderRadius: 12, marginBottom: 12 }}>
        <Text testID="home-card-label">Stats</Text>
      </View>
      <Text testID="home-welcome">`,
    );
    const { writeProjectFile } = await import("../src/orchestrator.ts");
    await writeProjectFile(projectId, indexPath, index);
    execSync(`docker exec ${container} touch /app/app/_layout.tsx`);
    console.log("  seeded home-card for card bg test");
  }

  if (
    !(await runCase(
      "text → home-welcome",
      '[Tap edit] In the app, find the element with testID "home-welcome" and replace the text "Welcome — your app loads here." with "Hello v2!". Change only what was tapped.',
      async (file) => {
        const content = await readProjectFile(projectId, file);
        return content.includes("Hello v2!") && !content.includes("Welcome — your app loads here.");
      },
    ))
  ) {
    failed++;
  }

  if (
    !(await runCase(
      "screen bg → tokens.ts",
      "[Tap edit] In the app, find the main screen background and set the screen background color to #e8f4ff. Change only what was tapped.",
      async () => {
        const tokens = dockerCat("src/theme/tokens.ts");
        return tokens.includes("#e8f4ff");
      },
    ))
  ) {
    failed++;
  }

  if (
    !(await runCase(
      "card bg → testID home-card",
      '[Tap edit] In the app, find the element with testID "home-card" and set the background color to #ffeedd. Change only what was tapped.',
      async (file) => {
        const content = await readProjectFile(projectId, file);
        return content.includes("#ffeedd") || content.includes("#FFEEDD");
      },
    ))
  ) {
    failed++;
  }

  const bridge = dockerCat("appable-bridge.js");
  const hasNonEditable =
    bridge.includes('data-appable") === "non-editable"') ||
    bridge.includes("isNonEditable");
  console.log(hasNonEditable ? "PASS" : "FAIL", "bridge blocks non-editable chrome");
  if (!hasNonEditable) failed++;

  const tabLayout = dockerCat("app/(tabs)/_layout.tsx");
  const hasTabGuard = tabLayout.includes('data-appable="non-editable"');
  console.log(hasTabGuard ? "PASS" : "FAIL", "tab bar marked non-editable on web");
  if (!hasTabGuard) failed++;

  console.log(failed === 0 ? "\nV2 TAP ACCEPTANCE PASSED" : `\n${failed} check(s) failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

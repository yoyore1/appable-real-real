import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const projectId = "cmqasb8hz0002tlgcam7oxt4v";
const container = `appable-proj-${projectId}`;

const files = [
  "app/(tabs)/index.tsx",
  "app/(tabs)/settings.tsx",
  "app/(stack)/add-habit.tsx",
  "app/(stack)/habits.tsx",
  "app/(stack)/legal.tsx",
  "app/(stack)/streak/[id].tsx",
  "src/lib/storage.ts",
  "src/components/AppButton.tsx",
  "src/components/Card.tsx",
  "src/components/Screen.tsx",
  "src/components/GroupedSection.tsx",
  "src/components/Row.tsx",
  "src/components/SettingsRow.tsx",
  "src/components/EmptyState.tsx",
  "src/components/SegmentedControl.tsx",
  "src/theme/tokens.ts",
];

let out = "";
for (const f of files) {
  try {
    const content = execSync(
      `docker exec ${container} sh -c "cat '/app/${f}'"`,
      { encoding: "utf8" },
    );
    out += `\n\n===== ${f} =====\n${content}`;
  } catch (e) {
    out += `\n\n===== ${f} =====\n<<<ERROR: ${e.message}>>>\n`;
  }
}

const target = join(process.cwd(), "live-app-dump.txt");
writeFileSync(target, out, "utf8");
console.log(`Dumped ${files.length} files to ${target} (${out.length} bytes)`);

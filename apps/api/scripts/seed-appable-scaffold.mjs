/**
 * Copy Appable scaffold (theme tokens + auth) into an existing project container
 * and install design dependencies if missing.
 *
 * Usage: node apps/api/scripts/seed-appable-scaffold.mjs <projectId>
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const projectId = process.argv[2];
if (!projectId) {
  console.error("Usage: node apps/api/scripts/seed-appable-scaffold.mjs <projectId>");
  process.exit(1);
}

const container = `appable-proj-${projectId}`;
const here = dirname(fileURLToPath(import.meta.url));
const templateDir = join(here, "../../../infra/expo-template/template-files");

function sh(cmd) {
  console.log(`> ${cmd.slice(0, 120)}${cmd.length > 120 ? "..." : ""}`);
  execSync(cmd, { stdio: "inherit" });
}

function writeFileInContainer(relPath, content) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const mkdir = dir ? `mkdir -p '/app/${dir}' && ` : "";
  sh(
    `docker exec ${container} sh -c "${mkdir}echo '${b64}' | base64 -d > '/app/${relPath}'"`,
  );
}

try {
  execSync(`docker inspect ${container}`, { stdio: "ignore" });
} catch {
  console.error(`Container ${container} not found. Wake the project first.`);
  process.exit(1);
}

for (const rel of [
  "src/theme/tokens.ts",
  "src/lib/auth.ts",
  "src/lib/storage.ts",
  "src/components/index.ts",
  "src/components/Screen.tsx",
  "src/components/Card.tsx",
  "src/components/AppButton.tsx",
  "src/components/Row.tsx",
  "src/components/EmptyState.tsx",
]) {
  const content = readFileSync(join(templateDir, rel), "utf8");
  writeFileInContainer(rel, content);
  console.log(`Wrote ${rel}`);
}

sh(
  `docker exec ${container} sh -c "cd /app && npx expo install @expo/vector-icons expo-font @expo-google-fonts/dm-sans @expo-google-fonts/fraunces"`,
);
sh(`docker exec ${container} touch /app/index.ts`);
console.log("\nScaffold seeded. Rebuild the app or ask Build chat to wire auth + design.");

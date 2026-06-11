/**
 * Downgrade a project's Expo SDK to 54 so Expo Go (App Store / Play Store) can open it.
 *
 * Usage: node apps/api/scripts/fix-expo-go-compat.mjs <projectId>
 */
import { execSync } from "node:child_process";

const projectId = process.argv[2];
if (!projectId) {
  console.error("Usage: node apps/api/scripts/fix-expo-go-compat.mjs <projectId>");
  process.exit(1);
}

const container = `appable-proj-${projectId}`;

function sh(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

try {
  execSync(`docker inspect ${container}`, { stdio: "ignore" });
} catch {
  console.error(`Container ${container} not found. Wake the project in the build screen first.`);
  process.exit(1);
}

sh(
  `docker exec ${container} sh -c "cd /app && npm install expo@~54.0.34 && npx expo install --fix && npx expo install react-dom react-native-web @expo/metro-runtime @react-native-async-storage/async-storage"`,
);
sh(`docker exec ${container} sh -c "cd /app && git add -A && git commit -m 'fix: expo sdk 54 for Expo Go' || true"`);
sh(`docker exec ${container} touch /app/index.ts`);

console.log("\nDone. Restart Expo Go on your phone, then scan the QR again.");

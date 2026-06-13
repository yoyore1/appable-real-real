// Copy infra/expo-template/template-files/appable-bridge.js into the live
// project container at /app/appable-bridge.js so the visual verification of
// the build-UI fix can use the new bridge.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = path.join(ROOT, "infra/expo-template/template-files/appable-bridge.js");
const PROJECT_ID = process.argv[2] ?? "appable-proj-cmqasb8hz0002tlgcam7oxt4v";

const content = readFileSync(SRC, "utf8");
const tmp = mkdtempSync(path.join(os.tmpdir(), "appable-bridge-"));
const tmpFile = path.join(tmp, "appable-bridge.js");
writeFileSync(tmpFile, content, "utf8");

try {
  execSync(`docker cp "${tmpFile}" ${PROJECT_ID}:/app/appable-bridge.js`, { stdio: "inherit" });
  const out = execSync(
    `docker exec ${PROJECT_ID} bash -c 'wc -l /app/appable-bridge.js && grep -c findBoxTestId /app/appable-bridge.js'`,
    { encoding: "utf8" },
  );
  console.log("Live bridge write:", out);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

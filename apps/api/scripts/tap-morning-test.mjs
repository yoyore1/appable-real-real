import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectFile, writeProjectFile } from "../src/orchestrator.ts";
import {
  tryTapEditPatch,
  probeTapEditRequest,
  loadTapEditSourceCache,
  buildTapEditReplaceMessage,
} from "../src/agent/tapEdit.ts";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const projectId = process.argv[2] ?? "cmqasb8hz0002tlgcam7oxt4v";
const reset = process.argv.includes("--reset");

const onlyMorning = process.argv.includes("--morning-only");
const resetOnly = process.argv.includes("--reset-only");

if (reset || resetOnly) {
  let storage = await readProjectFile(projectId, "src/lib/storage.ts");
  storage = storage.replace(/(id: "h1",\s*\n\s*name: ")[^"]+(")/, "$1Morning run$2");
  await writeProjectFile(projectId, "src/lib/storage.ts", storage);
  console.log("reset h1 name -> Morning run");
}

if (resetOnly) process.exit(0);

const storage = await readProjectFile(projectId, "src/lib/storage.ts");
console.log("h1 block:", storage.match(/id: "h1"[\s\S]{0,120}/)?.[0]);

const cases = onlyMorning
  ? [["Morning", "Morni"]]
  : [
      ["Morning ", "Morni"],
      ["Morning", "Morni"],
      ["Morning run", "Morni"],
    ];

for (const [oldText, newText] of cases) {
  const msg = `[Tap edit] In the app, find the element with testID "home-habit-h1-name" and replace the text "${oldText}" with "${newText}". Change only what was tapped.`;
  const result = await tryTapEditPatch(projectId, msg);
  console.log(JSON.stringify({ oldText, newText, result }));
}

const cache = await loadTapEditSourceCache(projectId);
console.log(
  "probe Morning:",
  probeTapEditRequest(buildTapEditReplaceMessage("home-habit-h1-name", "Morning", "Morni"), cache),
);

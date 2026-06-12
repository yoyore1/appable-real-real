import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectFile, writeProjectFile } from "../src/orchestrator.ts";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const projectId = "cmqasb8hz0002tlgcam7oxt4v";
const file = "app/(tabs)/index.tsx";
let content = await readProjectFile(projectId, file);
const before = content;
content = content.replace(
  /style=\{\[styles\.addButtonWrap, \{ backgroundColor: '#a37362' \}\]\}/,
  "style={styles.addButtonWrap}",
);
if (content !== before) {
  await writeProjectFile(projectId, file, content);
  console.log("cleaned addButtonWrap damage");
} else {
  console.log("no damage found");
}
console.log(content.split("\n").filter((l) => l.includes("addButtonWrap")).join("\n"));
process.exit(0);

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryTapEditPatch } from "../src/agent/tapEdit.ts";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const projectId = process.argv[2] ?? "cmqasb8hz0002tlgcam7oxt4v";
const msg =
  '[Tap edit] In the app, find the element with testID "home-habit-h1-name" and replace the text "Morning run" with "Morning ". Change only what was tapped.';

const result = await tryTapEditPatch(projectId, msg);
console.log(result);

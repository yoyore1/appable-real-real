import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "../src/orchestrator.ts"), "utf8");
const start = src.indexOf("const EDIT_BRIDGE_SOURCE = `") + "const EDIT_BRIDGE_SOURCE = `".length;
const end = src.indexOf("`;\n\n/** Write the edit bridge", start);
if (start < 0 || end < 0) throw new Error("bridge block not found");
const bridge = src.slice(start, end);
const out = path.join(here, "../../../infra/expo-template/template-files/appable-bridge.js");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, bridge);
console.log(`Wrote ${bridge.length} bytes to ${out}`);

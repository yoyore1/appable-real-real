import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Side-effect import Metro resolves reliably from TypeScript entry. */
export const BRIDGE_FILENAME = "appable-bridge.js";
export const BRIDGE_IMPORT = 'import "./appable-bridge.js";';

const BRIDGE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../infra/expo-template/template-files/appable-bridge.js",
);

let cachedBridge: string | null = null;

export function loadBridgeSource(): string {
  if (cachedBridge) return cachedBridge;
  cachedBridge = fs.readFileSync(BRIDGE_PATH, "utf8");
  return cachedBridge;
}

/** Agent must never write these — platform owns them. */
export const AGENT_WRITE_DENY = new Set([
  BRIDGE_FILENAME,
  "metro.config.js",
  "metro.config.ts",
  "metro.config.mjs",
  "metro.config.cjs",
]);

/** Agent must never delete these (platform may remove bad metro configs). */
export const AGENT_DELETE_DENY = new Set([BRIDGE_FILENAME]);

const BRIDGE_LINE_RE =
  /^\s*(\/\/.*)?$|^\s*import\s+["']\.?\/?appable-bridge(?:\.js)?["'];?\s*$|^\s*require\s*\(\s*["'][^"']*appable-bridge[^"']*["']\s*\);?\s*$/;

/** Strip agent bridge/metro hacks; ensure exactly one canonical import at top. */
export function normalizeIndexTs(content: string): string {
  const lines = content.replace(/^\uFEFF/, "").split("\n");
  const body = lines.filter((line) => !BRIDGE_LINE_RE.test(line));
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  return `${BRIDGE_IMPORT}\n${body.join("\n")}`.replace(/\n{3,}/g, "\n\n");
}

export function normalizeAgentPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^app\//, "");
}

export function assertAgentWriteAllowed(
  filePath: string,
  content: string,
): { ok: true; content: string } | { ok: false; message: string } {
  const path = normalizeAgentPath(filePath);
  if (AGENT_WRITE_DENY.has(path)) {
    return {
      ok: false,
      message:
        `write_file blocked: ${path} is platform-owned (tap-to-edit bridge / Metro config). ` +
        "Fix app code in App.tsx or src/ only. The platform repairs bridge wiring automatically.",
    };
  }
  if (path === "index.ts") {
    return { ok: true, content: normalizeIndexTs(content) };
  }
  return { ok: true, content };
}

export function assertAgentDeleteAllowed(filePath: string): { ok: true } | { ok: false; message: string } {
  const path = normalizeAgentPath(filePath);
  if (AGENT_DELETE_DENY.has(path)) {
    return {
      ok: false,
      message: `delete_file blocked: ${path} is required for tap-to-edit and is managed by the platform.`,
    };
  }
  return { ok: true };
}

export function assertAgentCommandAllowed(command: string): { ok: true } | { ok: false; message: string } {
  const cmd = command.toLowerCase();
  if (/appable-bridge|metro\.config/.test(cmd)) {
    return {
      ok: false,
      message:
        "run_command blocked: do not modify appable-bridge or metro.config via shell. Fix App.tsx / src/ only.",
    };
  }
  return { ok: true };
}

export function isBridgeBundleError(message: string): boolean {
  return /appable-bridge|unable to resolve.*bridge/i.test(message);
}

/** Prompt snippet — agents must not touch platform glue. */
export const PLATFORM_AGENT_RULES = `### PLATFORM FILES (never modify — auto-repaired)
- appable-bridge.js — tap-to-edit bridge (platform-owned)
- index.ts — platform keeps \`import "./appable-bridge.js";\` at the top; do not rewrite entry
- metro.config.js/ts — NEVER create or edit Metro config to "fix" resolution errors
If read_build_logs mentions appable-bridge, fix App.tsx / src/ only — the platform repairs glue.`;

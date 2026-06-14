import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redirectRogueTabWrite } from "./routerGlue.js";

/** Side-effect import for Expo Router apps — lives in app/_layout.tsx. */
export const BRIDGE_FILENAME = "appable-bridge.js";
export const BRIDGE_IMPORT = 'import "./appable-bridge.js";';
export const BRIDGE_IMPORT_APP_LAYOUT = 'import "../appable-bridge.js";';
export const APP_LAYOUT_PATH = "app/_layout.tsx";

/** Platform-owned base components in src/components/ (do not modify — use them). */
export const PLATFORM_COMPONENT_FILES = new Set([
  "src/components/Screen.tsx",
  "src/components/Card.tsx",
  "src/components/AppButton.tsx",
  "src/components/Row.tsx",
  "src/components/EmptyState.tsx",
  "src/components/GroupedSection.tsx",
  "src/components/SettingsRow.tsx",
  "src/components/SegmentedControl.tsx",
  "src/components/SearchField.tsx",
  "src/components/Sheet.tsx",
  "src/components/AppAlert.tsx",
  "src/components/ActionMenu.tsx",
  "src/components/Blur.tsx",
  "src/components/AppIcon.tsx",
  "src/components/EditableText.tsx",
  "src/components/EditableIcon.tsx",
  "src/components/EditableBackground.tsx",
  "src/components/index.ts",
]);

/** Agent must never write these — platform owns them. */
export const AGENT_WRITE_DENY = new Set([
  BRIDGE_FILENAME,
  APP_LAYOUT_PATH,
  "app/(tabs)/_layout.tsx",
  "app/(stack)/_layout.tsx",
  "metro.config.js",
  "metro.config.ts",
  "metro.config.mjs",
  "metro.config.cjs",
  ...PLATFORM_COMPONENT_FILES,
]);

const BRIDGE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../infra/expo-template/template-files/appable-bridge.js",
);

let cachedBridge: string | null = null;
let cachedBridgeMtime = 0;

export function loadBridgeSource(): string {
  const stat = fs.statSync(BRIDGE_PATH);
  if (cachedBridge && stat.mtimeMs === cachedBridgeMtime) return cachedBridge;
  cachedBridge = fs.readFileSync(BRIDGE_PATH, "utf8");
  cachedBridgeMtime = stat.mtimeMs;
  return cachedBridge;
}

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

const BRIDGE_IMPORT_ANY_RE =
  /^\s*import\s+["'][^"']*appable-bridge(?:\.js)?["'];?\s*$/;

/** Ensure bridge import at top of Expo Router root layout. */
export function normalizeAppLayout(content: string): string {
  const lines = content.replace(/^\uFEFF/, "").split("\n");
  const body = lines.filter((line) => !BRIDGE_IMPORT_ANY_RE.test(line));
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  return `${BRIDGE_IMPORT_APP_LAYOUT}\n${body.join("\n")}`.replace(/\n{3,}/g, "\n\n");
}

export function normalizeAgentPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function assertAgentWriteAllowed(
  filePath: string,
  content: string,
): { ok: true; content: string; path: string } | { ok: false; message: string } {
  let path = redirectRogueTabWrite(normalizeAgentPath(filePath));
  if (AGENT_WRITE_DENY.has(path)) {
    return {
      ok: false,
      message:
        `write_file blocked: ${path} is platform-owned (bridge / router layouts / Metro). ` +
        "Use app/(tabs)/index.tsx or settings.tsx for tab roots; put other screens in app/(stack)/.",
    };
  }
  if (path === "index.ts") {
    return { ok: true, content: normalizeIndexTs(content), path };
  }
  if (path === APP_LAYOUT_PATH) {
    return { ok: true, content: normalizeAppLayout(content), path };
  }
  return { ok: true, content, path };
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
        "run_command blocked: do not modify appable-bridge or metro.config via shell. Fix route/screen files only.",
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
- app/_layout.tsx — root Expo Router layout (bridge import at top)
- app/(tabs)/_layout.tsx — tab shell: Home + Settings only (platform-owned)
- app/(stack)/_layout.tsx — stack shell for secondary screens (platform-owned)
- metro.config.js/ts — NEVER create or edit Metro config to "fix" resolution errors
- src/components/ base components (Screen, Card, AppButton, Row, EmptyState,
  GroupedSection, SettingsRow, SegmentedControl, SearchField, Sheet, AppAlert,
  ActionMenu, Blur, AppIcon, EditableText, EditableIcon, EditableBackground) are
  platform-owned. Use them from screens; do NOT rewrite their internals.
Tab bar = Home + Settings ONLY. Put habits, detail, legal, add flows in app/(stack)/.
Navigate with router.push('/habits') — stack screens must NOT live under app/(tabs)/.
If read_build_logs mentions appable-bridge, fix app/(tabs)/*.tsx, app/(stack)/*.tsx, or src/ only.`;

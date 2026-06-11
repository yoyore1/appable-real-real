import { Redis } from "ioredis";
import { env } from "./env.js";
import { listProjectFiles, readProjectFile } from "./orchestrator.js";

const redis = new Redis(env.redisUrl);
const CACHE_KEY = (projectId: string) => `appable:brainstorm:${projectId}`;
const CACHE_TTL_SEC = 60 * 60 * 24 * 30;

const SNAPSHOT_FILES = [
  /^App\.tsx$/,
  /^src\/screens\/.+\.tsx$/,
  /^src\/components\/TabBar\.tsx$/,
  /^src\/lib\/.+\.(ts|tsx)$/,
  /^src\/data\/.+\.(ts|tsx)$/,
];

/** Fire-and-forget after build/edit/tap changes so brainstorm stays current. */
export function scheduleBrainstormSnapshotRefresh(projectId: string): void {
  void refreshBrainstormSnapshot(projectId).catch(() => {});
}

export async function refreshBrainstormSnapshot(projectId: string): Promise<void> {
  const snap = await buildLiveSnapshot(projectId);
  if (snap) await cacheSnapshot(projectId, snap);
}

/** Live container read when running; otherwise last cached snapshot. */
export async function loadBrainstormAppSnapshot(projectId: string): Promise<string | null> {
  const live = await buildLiveSnapshot(projectId);
  if (live) {
    await cacheSnapshot(projectId, live);
    return live;
  }
  return getCachedSnapshot(projectId);
}

async function buildLiveSnapshot(projectId: string): Promise<string | null> {
  let files: string[];
  try {
    files = await listProjectFiles(projectId);
  } catch {
    return null;
  }
  if (!files.includes("App.tsx") && files.every((f) => !f.startsWith("src/screens/"))) {
    return null;
  }

  const parts: string[] = [`As of ${new Date().toISOString()} (from the live built app):`];

  const screenFiles = files.filter((f) => /^src\/screens\/.+\.tsx$/.test(f));
  const componentFiles = files.filter(
    (f) => /^src\/components\/.+\.tsx$/.test(f) && !f.endsWith("ScreenWrapper.tsx"),
  );
  parts.push(
    `Screens in code (${screenFiles.length}): ${screenFiles.map((f) => f.replace("src/screens/", "").replace(".tsx", "")).join(", ") || "none yet"}`,
  );
  if (componentFiles.length) {
    parts.push(
      `Shared UI pieces: ${componentFiles.map((f) => f.replace("src/components/", "").replace(".tsx", "")).join(", ")}`,
    );
  }

  const readSafe = async (path: string): Promise<string | null> => {
    try {
      return await readProjectFile(projectId, path);
    } catch {
      return null;
    }
  };

  if (files.includes("App.tsx")) {
    const app = await readSafe("App.tsx");
    if (app) parts.push(...summarizeAppEntry(app));
  }

  for (const path of files.filter((f) => SNAPSHOT_FILES.some((re) => re.test(f)))) {
    if (path === "App.tsx") continue;
    const content = await readSafe(path);
    if (!content) continue;
    const label = path.replace(/^src\//, "");
    const copy = extractUserVisibleCopy(content);
    const data = extractDataHighlights(content);
    const bits = [...data, ...copy];
    if (bits.length) parts.push(`${label}: ${bits.join("; ")}`);
  }

  return parts.join("\n");
}

function summarizeAppEntry(app: string): string[] {
  const lines: string[] = [];
  const screens = [
    ...new Set([...app.matchAll(/screens\/(\w+)/g)].map((m) => m[1])),
  ];
  if (screens.length) lines.push(`App wires these screens: ${screens.join(", ")}`);

  const tabs = [...app.matchAll(/label:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (tabs.length) lines.push(`Bottom tabs / nav labels: ${tabs.join(", ")}`);

  const stateScreen = app.match(/useState(?:<[^>]+>)?\(\s*['"](\w+)['"]/);
  if (stateScreen) lines.push(`Default screen on open: ${stateScreen[1]}`);

  return lines;
}

function extractUserVisibleCopy(content: string, max = 14): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;

  const patterns = [
    /\{["']([^"'\\]{3,72})["']\}/g,
    /label:\s*['"]([^'"]+)['"]/g,
    /title:\s*['"]([^'"]+)['"]/g,
    /placeholder=["']([^"']+)["']/g,
  ];

  for (const re of patterns) {
    while ((m = re.exec(content)) !== null) {
      const t = m[1].trim();
      if (t.length < 3 || /^[\d\s#.%$]+$/.test(t)) continue;
      if (/^test-?id$/i.test(t) || t.includes("${")) continue;
      found.add(t);
    }
  }

  return [...found].slice(0, max);
}

function extractDataHighlights(content: string): string[] {
  const lines: string[] = [];
  const entities = [...content.matchAll(/(?:type|interface)\s+(\w+)/g)].map((m) => m[1]);
  if (entities.length) {
    lines.push(`data types: ${[...new Set(entities)].slice(0, 6).join(", ")}`);
  }
  const keys = [...content.matchAll(/(?:STORAGE_KEY|storageKey)\s*=\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  );
  if (keys.length) lines.push(`persists under: ${keys.join(", ")}`);
  return lines;
}

async function cacheSnapshot(projectId: string, text: string): Promise<void> {
  await redis.set(CACHE_KEY(projectId), text, "EX", CACHE_TTL_SEC);
}

async function getCachedSnapshot(projectId: string): Promise<string | null> {
  const raw = await redis.get(CACHE_KEY(projectId));
  if (!raw) return null;
  return `Last known built app (container asleep — refreshed after last build/edit):\n${raw}`;
}

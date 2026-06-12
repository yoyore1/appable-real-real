import { listProjectFiles, readProjectFile } from "../orchestrator.js";
import {
  buildTapEditBackgroundMessage,
  buildTapEditColorMessage,
  buildTapEditReplaceMessage,
  loadTapEditSourceCache,
  probeTapEditRequest,
} from "./tapEdit.js";
import {
  deriveRowTestIdFromLabel,
  expandTemplateTestId,
  parseDataRecords,
} from "./tapEditDiscovery.js";

export interface TapEditProbeFailure {
  file: string;
  line: number;
  testId: string;
  text: string;
  kind: "text" | "color" | "background";
}

const PROBE_ROUTE_GLOBS = [
  /^app\/\(tabs\)\/.+\.(tsx|jsx)$/,
  /^app\/\(stack\)\/.+\.(tsx|jsx)$/,
  /^(src\/screens|src\/components)\/.+\.(tsx|jsx)$/,
  /^App\.tsx$/,
];

const SKIP_PROBE_TEXT = new Set([
  "Loading...",
  "Loading",
  "Done",
  "Tap",
  "...",
  "Settings",
  "Home",
  "Habits",
  "Go back",
  "Cancel",
  "Delete",
]);

function isProbeRouteFile(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return PROBE_ROUTE_GLOBS.some((re) => re.test(norm));
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function isBroadContainerTestId(testId: string): boolean {
  const id = testId.toLowerCase();
  if (/-(screen|scrollview|scroll-view|root|layout|wrapper|container|page)$/.test(id)) {
    return true;
  }
  return id.endsWith("-scroll") || id.endsWith("-safe");
}

function probeNewText(oldText: string): string {
  if (oldText.length > 3) return oldText.slice(0, -1);
  return `${oldText}x`;
}

function parseStaticTestId(attrs: string): string | null {
  const m =
    attrs.match(/testID=["']([^"']+)["']/) ??
    attrs.match(/testID=\{\s*["']([^"']+)["']\s*\}/);
  return m?.[1] ?? null;
}

function parseTemplateTestId(attrs: string): string | null {
  const m = attrs.match(/testID=\{\`([^\`]+)\`\}/);
  return m?.[1] ?? null;
}

type DataRecord = Record<string, string>;

function parseListItemIdFromTestId(testId: string, fieldSuffix: string): string | null {
  const tail = `-${fieldSuffix}`;
  if (!testId.endsWith(tail)) return null;
  const body = testId.slice(0, -tail.length);
  const idx = body.lastIndexOf("-");
  if (idx <= 0) return null;
  return body.slice(idx + 1);
}

async function loadDataRecords(projectId: string): Promise<Map<string, DataRecord>> {
  const merged = new Map<string, DataRecord>();
  const files = await listProjectFiles(projectId);
  for (const file of files) {
    const norm = file.replace(/\\/g, "/");
    if (!/^src\/lib\/.+\.(ts|tsx)$/.test(norm)) continue;
    const content = await readProjectFile(projectId, file);
    for (const [id, record] of parseDataRecords(content)) {
      merged.set(id, record);
    }
  }
  return merged;
}

function resolveIdentifierText(content: string, ident: string): string | null {
  const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:export\\s+)?(?:const|let)\\s+${escaped}\\s*=\\s*["']([^"']+)["']`,
  );
  return content.match(re)?.[1] ?? null;
}

function resolvePropFieldText(
  inner: string,
  records: Map<string, DataRecord>,
  testId: string,
): string | null {
  const m = inner.match(/^\{(\w+)\.(\w+)\}$/);
  if (!m) return null;
  const [, , field] = m;
  const suffix = field === "description" ? "desc" : field;
  const id = parseListItemIdFromTestId(testId, suffix);
  if (!id) return null;
  return records.get(id)?.[field] ?? records.get(id)?.[suffix] ?? null;
}

interface ProbeTarget {
  file: string;
  line: number;
  testId: string;
  text: string;
}

function collectProbeTargets(
  file: string,
  content: string,
  records: Map<string, DataRecord>,
): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  const seen = new Set<string>();
  const re = /<Text\b([^>]*)>([\s\S]*?)<\/Text>/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    const attrs = m[1] ?? "";
    const inner = (m[2] ?? "").trim();
    const line = lineNumberAt(content, m.index);

    const staticId = parseStaticTestId(attrs);
    const template = parseTemplateTestId(attrs);

    if (staticId) {
      if (isBroadContainerTestId(staticId)) continue;
      const text = resolveLabelText(content, inner, records, staticId);
      if (!text || text.length < 2 || SKIP_PROBE_TEXT.has(text)) continue;
      const key = `${staticId}\0${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ file, line, testId: staticId, text });
      continue;
    }

    if (template) {
      const propInner = inner.match(/^\{(\w+)\.(\w+)\}$/);
      if (!propInner) continue;
      const field = propInner[2];
      for (const [id, record] of records) {
        const testId = expandTemplateTestId(template, id);
        if (isBroadContainerTestId(testId)) continue;
        const text = record[field];
        if (!text || text.length < 2 || SKIP_PROBE_TEXT.has(text)) continue;
        const key = `${testId}\0${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ file, line, testId, text });
      }
    }
  }

  return targets;
}

function resolveLabelText(
  fileContent: string,
  inner: string,
  records: Map<string, DataRecord>,
  testId: string,
): string | null {
  if (inner.includes("{")) {
    const ident = inner.match(/^\{([A-Za-z_$][\w$]*)\}$/);
    if (ident) return resolveIdentifierText(fileContent, ident[1]);
    return resolvePropFieldText(inner, records, testId);
  }
  const literal = inner.replace(/^["']|["']$/g, "").trim();
  return literal.length > 0 ? literal : null;
}

function probeTarget(
  sources: Map<string, string>,
  message: string,
): { ok: true } | { ok: false } {
  return probeTapEditRequest(message, sources).ok ? { ok: true } : { ok: false };
}

/** Static audit shape + dry-run patch probe for labels, colors, and row backgrounds. */
export async function probeTapEditSave(projectId: string): Promise<TapEditProbeFailure[]> {
  const [sources, records] = await Promise.all([
    loadTapEditSourceCache(projectId),
    loadDataRecords(projectId),
  ]);

  const failures: TapEditProbeFailure[] = [];
  const probed = new Set<string>();

  for (const [file, content] of sources) {
    if (!isProbeRouteFile(file)) continue;
    for (const target of collectProbeTargets(file, content, records)) {
      const newText = probeNewText(target.text);

      const textKey = `text\0${target.testId}\0${target.text}`;
      if (!probed.has(textKey)) {
        probed.add(textKey);
        const textMsg = buildTapEditReplaceMessage(target.testId, target.text, newText);
        if (!probeTarget(sources, textMsg).ok) {
          failures.push({ ...target, kind: "text" });
        }
      }

      const colorKey = `color\0${target.testId}`;
      if (!probed.has(colorKey)) {
        probed.add(colorKey);
        const colorMsg = buildTapEditColorMessage(target.testId, "#ff5500");
        if (!probeTarget(sources, colorMsg).ok) {
          failures.push({ ...target, kind: "color" });
        }
      }

      const rowId = deriveRowTestIdFromLabel(target.testId);
      if (rowId) {
        const bgKey = `bg\0${rowId}`;
        if (!probed.has(bgKey)) {
          probed.add(bgKey);
          const bgMsg = buildTapEditBackgroundMessage(rowId, "#112233");
          if (!probeTarget(sources, bgMsg).ok) {
            failures.push({ ...target, testId: rowId, kind: "background" });
          }
        }
      }
    }
  }

  return failures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatTapEditProbeReport(failures: TapEditProbeFailure[], maxItems = 20): string {
  if (failures.length === 0) {
    return "Tap-edit save probe: all probed labels, colors, and row backgrounds would persist to source.";
  }

  const counts = new Map<string, number>();
  for (const f of failures) {
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ");

  const lines = [
    `Tap-edit save probe: ${failures.length} gap(s) — ${summary}.`,
    "Fix testID templates, row testIDs, or storage layout so tap-to-edit saves for every app shape.",
    "",
  ];

  for (const f of failures.slice(0, maxItems)) {
    lines.push(
      `- ${f.file}:${f.line} [${f.kind}] testID="${f.testId}" text="${f.text.slice(0, 40)}"`,
    );
  }
  if (failures.length > maxItems) {
    lines.push(`... and ${failures.length - maxItems} more`);
  }
  return lines.join("\n");
}

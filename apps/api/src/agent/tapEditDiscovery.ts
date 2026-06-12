/** Dynamic discovery for v2 tap-to-edit — no app-specific hardcodes. */

export const LIST_ITEM_FIELD_SUFFIX: Record<string, string> = {
  name: "name",
  desc: "description",
  title: "title",
  label: "label",
  streak: "streak",
  info: "info",
};

export const LIST_ITEM_CONTAINER_SUFFIXES = ["row", "card", "item", "pressable"] as const;

export type ListItemContext = {
  templatePrefix: string;
  itemId: string;
  fieldSuffix: string;
};

export type DataRecord = Record<string, string>;

export function parseListItemId(testId: string, fieldSuffix: string): string | null {
  const tail = `-${fieldSuffix}`;
  if (!testId.endsWith(tail)) return null;
  const body = testId.slice(0, -tail.length);
  const idx = body.lastIndexOf("-");
  if (idx <= 0) return null;
  return body.slice(idx + 1);
}

export function parseListItemTestContext(testId: string): ListItemContext | null {
  const suffixes = [
    ...Object.keys(LIST_ITEM_FIELD_SUFFIX),
    ...LIST_ITEM_CONTAINER_SUFFIXES,
  ];
  for (const fieldSuffix of suffixes) {
    const itemId = parseListItemId(testId, fieldSuffix);
    if (!itemId) continue;
    const body = testId.slice(0, -(fieldSuffix.length + 1));
    const templatePrefix = body.slice(0, body.length - itemId.length - 1);
    if (!templatePrefix) continue;
    return { templatePrefix, itemId, fieldSuffix };
  }
  return null;
}

export function isListItemFieldTestId(testId: string): boolean {
  const ctx = parseListItemTestContext(testId);
  if (!ctx) return false;
  return ctx.fieldSuffix in LIST_ITEM_FIELD_SUFFIX;
}

export function swapListItemTestIdSuffix(testId: string, newSuffix: string): string | null {
  const ctx = parseListItemTestContext(testId);
  if (!ctx) return null;
  return `${ctx.templatePrefix}-${ctx.itemId}-${newSuffix}`;
}

export function deriveRowTestIdFromLabel(labelTestId: string): string | null {
  for (const suffix of LIST_ITEM_CONTAINER_SUFFIXES) {
    const row = swapListItemTestIdSuffix(labelTestId, suffix);
    if (row) return row;
  }
  return null;
}

export function expandTemplateTestId(template: string, id: string): string {
  return template.replace(/\$\{\w+(?:\.\w+)?\}/g, id);
}

export function parseDataRecords(content: string): Map<string, DataRecord> {
  const byId = new Map<string, DataRecord>();
  const re = /\{\s*id:\s*["']([^"']+)["']([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    const body = m[2] ?? "";
    const fields: DataRecord = { id };
    for (const fm of body.matchAll(/(\w+):\s*["']([^"']*)["']/g)) {
      fields[fm[1]] = fm[2];
    }
    byId.set(id, fields);
  }
  return byId;
}

export function parseDataRecordsFromSources(
  sources: Map<string, string>,
): Map<string, DataRecord> {
  const merged = new Map<string, DataRecord>();
  for (const [file, content] of sources) {
    const norm = file.replace(/\\/g, "/");
    if (!/^src\/lib\/.+\.(ts|tsx)$/.test(norm)) continue;
    for (const [id, record] of parseDataRecords(content)) {
      merged.set(id, record);
    }
  }
  return merged;
}

function anchorMatchesRecordValue(anchorText: string, value: string): boolean {
  const a = anchorText.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  if (!a || !v) return false;
  return v === a || v.startsWith(a) || a.startsWith(v);
}

/**
 * Match a visible label to a runtime list-item testID by scanning
 * template testIDs × data records — works for any prefix/entity.
 */
export function resolveListItemTestIdFromAnchor(
  sources: Map<string, string>,
  anchorText: string,
): string | null {
  const records = parseDataRecordsFromSources(sources);
  if (records.size === 0) return null;

  for (const [file, content] of sources) {
    if (!/\.(tsx|jsx)$/.test(file.replace(/\\/g, "/"))) continue;
    const re = /testID=\{\`([^\`]+)\`\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const template = m[1] ?? "";
      if (!/\$\{\w+(?:\.\w+)?\}/.test(template)) continue;
      for (const [suffix, fieldName] of Object.entries(LIST_ITEM_FIELD_SUFFIX)) {
        if (!template.endsWith(`-${suffix}`)) continue;
        for (const [id, record] of records) {
          const val = record[fieldName] ?? record[suffix] ?? "";
          if (!anchorMatchesRecordValue(anchorText, val)) continue;
          return expandTemplateTestId(template, id);
        }
      }
    }
  }
  return null;
}

/** Candidate testIDs for list-item style patches (label → row for backgrounds). */
export function listItemStyleTestIdCandidates(
  testId: string,
  prop: "color" | "backgroundColor" | "fontWeight" | "fontFamily",
): string[] {
  const out: string[] = [testId];
  if (prop === "backgroundColor" && isListItemFieldTestId(testId)) {
    const row = deriveRowTestIdFromLabel(testId);
    if (row) out.push(row);
  }
  return [...new Set(out)];
}

/**
 * Field suffixes that ARE containers (badge, status, etc.) — text-color/bold
 * patches against them should still target the small inline element, not paint
 * the row.
 */
export const LIST_ITEM_CONTAINER_FIELD_SUFFIXES = new Set([
  "streak",
  "info",
  "row",
  "card",
]);

export function isInMapScope(content: string, pos: number): boolean {
  const windowStart = Math.max(0, pos - 900);
  return /\.map\s*\(\s*\(\s*\w+/.test(content.slice(windowStart, pos));
}

/** True when patching this tag unconditionally would affect every mapped row. */
export function isSharedMapTemplateElement(
  content: string,
  el: { start: number; tag: string },
): boolean {
  if (!isInMapScope(content, el.start)) return false;
  return /testID\s*=/.test(el.tag) && /\$\{\w+(?:\.\w+)?\}/.test(el.tag);
}

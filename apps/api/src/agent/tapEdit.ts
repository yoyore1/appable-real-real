import { emit } from "../events.js";
import { listProjectFiles, readProjectFile, writeProjectFile } from "../orchestrator.js";

type StyleProp = "color" | "backgroundColor";

export interface TapEditChange {
  type: "text" | "color" | "background";
  value: string;
  /** Original text for scoped replacements inside a container. */
  oldValue?: string;
  /** Label inside the card whose background should change (e.g. "Tue"). */
  anchorText?: string;
}

export interface TapEditRequest {
  testId: string | null;
  changes: TapEditChange[];
}

/** Parse a [Tap edit] message from the build UI. */
export function parseTapEditRequest(request: string): TapEditRequest | null {
  const m = request.match(
    /^\[Tap edit\] In the app, find (.+?) and (.+)\. Change only (?:this element|the matching text|what was tapped)\.$/u,
  );
  if (!m) return null;

  const target = m[1];
  const testId =
    target.match(/testID "([^"]+)"/)?.[1] ??
    target.match(/testID '([^']+)'/)?.[1] ??
    null;

  const changes: TapEditChange[] = [];
  for (const part of m[2].split("; ").map((s) => s.trim()).filter(Boolean)) {
    const replace = part.match(/^replace the text "(.+)" with "(.+)"$/);
    if (replace) {
      changes.push({ type: "text", oldValue: replace[1], value: replace[2] });
      continue;
    }
    const text = part.match(/^set the text to "(.+)"$/);
    if (text) {
      changes.push({ type: "text", value: text[1] });
      continue;
    }
    const colorScoped = part.match(/^set the text color of "(.+)" to (#[0-9A-Fa-f]{3,8})$/u);
    if (colorScoped) {
      changes.push({
        type: "color",
        value: colorScoped[2],
        anchorText: colorScoped[1],
      });
      continue;
    }
    const color = part.match(/^set the text color to (#[0-9A-Fa-f]{3,8})$/);
    if (color) {
      changes.push({ type: "color", value: color[1] });
      continue;
    }
    const bgScoped = part.match(
      /^set the background color of the container for "(.+)" to (#[0-9A-Fa-f]{3,8})$/u,
    );
    if (bgScoped) {
      changes.push({
        type: "background",
        value: bgScoped[2],
        anchorText: bgScoped[1],
      });
      continue;
    }
    const bg = part.match(/^set the background color to (#[0-9A-Fa-f]{3,8})$/);
    if (bg) {
      changes.push({ type: "background", value: bg[1] });
    }
  }

  if (changes.length === 0) return null;
  return { testId, changes };
}

/**
 * Apply tap-to-edit color/background changes directly in source files.
 * Preview-only DOM tweaks from the bridge are not persisted — this is.
 */
export async function tryTapEditPatch(
  projectId: string,
  request: string,
): Promise<{ ok: true; summary: string; file: string } | { ok: false }> {
  const parsed = parseTapEditRequest(request);
  if (!parsed) return { ok: false };

  const hasWork = parsed.changes.some(
    (c) =>
      c.type === "color" ||
      c.type === "background" ||
      (c.type === "text" && c.oldValue),
  );
  if (!hasWork) return { ok: false };

  const hasAnchor = parsed.changes.some((c) => c.anchorText);
  const effectiveTestId =
    parsed.testId && !isBroadContainerTestId(parsed.testId) ? parsed.testId : "";
  if (!effectiveTestId && !hasAnchor) return { ok: false };

  const candidates = await findCandidateFiles(projectId, parsed.testId, parsed.changes);
  if (candidates.length === 0) return { ok: false };

  for (const file of candidates) {
    const content = await readProjectFile(projectId, file);
    const updated = patchTapEditInFile(content, effectiveTestId, parsed.changes);
    if (updated && updated !== content) {
      await writeProjectFile(projectId, file, updated);
      emit(projectId, { type: "file.op", op: "write", path: file });
      return { ok: true, summary: tapEditSummary(parsed.changes), file };
    }
  }

  return { ok: false };
}

async function findCandidateFiles(
  projectId: string,
  testId: string | null,
  changes: TapEditChange[],
): Promise<string[]> {
  const specificTestId =
    testId && !isBroadContainerTestId(testId) ? testId : null;
  if (specificTestId) {
    const hits = await findFilesWithTestId(projectId, specificTestId);
    if (hits.length > 0) return hits;
  }

  const anchor = changes.find((c) => c.anchorText)?.anchorText;
  if (anchor) {
    const files = await listProjectFiles(projectId);
    const tsx = files.filter((f) => /\.(tsx|jsx)$/.test(f));
    const withAnchor: string[] = [];
    for (const file of tsx) {
      const content = await readProjectFile(projectId, file);
      if (content.includes(anchor)) withAnchor.push(file);
    }
    if (withAnchor.length > 0) return withAnchor;
  }

  // Broad screen testIDs still narrow which file to search.
  if (testId && isBroadContainerTestId(testId)) {
    const hits = await findFilesWithTestId(projectId, testId);
    if (hits.length > 0) return hits;
  }

  return [];
}

async function findFilesWithTestId(projectId: string, testId: string): Promise<string[]> {
  const files = await listProjectFiles(projectId);
  const hits: string[] = [];
  const needles = [
    `testID="${testId}"`,
    `testID='${testId}'`,
    `testID={"${testId}"}`,
    `testID={'${testId}'}`,
  ];
  for (const file of files) {
    if (!/\.(tsx|jsx)$/.test(file)) continue;
    const content = await readProjectFile(projectId, file);
    if (needles.some((n) => content.includes(n))) hits.push(file);
  }
  return hits;
}

function extractTestIdFromTag(tag: string): string | null {
  const m = tag.match(/testID=(?:"([^"]+)"|'([^']+)'|\{["']([^"']+)["']\})/);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

function isBroadContainerTestId(testId: string): boolean {
  return /(?:^|_|-)(screen|scroll|root|layout|wrapper|container|page|home|app|content|section|header)(?:$|_|-)/i.test(
    testId,
  );
}

function patchTapEditInFile(
  content: string,
  testId: string,
  changes: TapEditChange[],
): string | null {
  let tag = testId ? findOpeningTagAtTestId(content, testId) : null;
  let opening = tag?.tag ?? "";
  let touched = false;

  for (const change of changes) {
    if (change.type === "text" && change.oldValue) {
      if (!tag) return null;
      const replaced = patchTextReplaceInScope(content, tag, change.oldValue, change.value);
      if (!replaced) return null;
      content = replaced;
      tag = testId ? findOpeningTagAtTestId(content, testId) : null;
      if (!tag) return null;
      opening = tag.tag;
      touched = true;
      continue;
    }

    if (change.type === "text") {
      if (!tag) return null;
      const withText = patchTextContent(content, tag, change.value);
      if (withText) {
        content = withText;
        tag = testId ? findOpeningTagAtTestId(content, testId) : null;
        if (!tag) return null;
        opening = tag.tag;
        touched = true;
      }
      continue;
    }

    if (change.type === "background") {
      let patchedBg: string | null = null;
      if (testId) patchedBg = patchBackgroundByTestId(content, testId, change.value);
      if (!patchedBg && change.anchorText) {
        patchedBg = patchBackgroundNearText(content, change.anchorText, change.value, null);
      }
      if (patchedBg) {
        content = patchedBg;
        tag = testId ? findOpeningTagAtTestId(content, testId) : tag;
        opening = tag?.tag ?? opening;
        touched = true;
        continue;
      }
      if (!tag) continue;
      const next = patchStyleOnTag(opening, "backgroundColor", change.value);
      if (!next) continue;
      content = replaceTagAt(content, tag, next);
      tag = { start: tag.start, end: tag.start + next.length, tag: next };
      opening = next;
      touched = true;
      continue;
    }

    if (change.type === "color") {
      let patchedColor: string | null = null;
      if (testId) patchedColor = patchTextColorByTestId(content, testId, change.value);
      if (!patchedColor && change.anchorText) {
        patchedColor = patchTextColorNearText(content, change.anchorText, change.value);
      }
      if (patchedColor) {
        content = patchedColor;
        tag = testId ? findOpeningTagAtTestId(content, testId) : tag;
        opening = tag?.tag ?? opening;
        touched = true;
        continue;
      }
      if (!tag) continue;
      const next = patchStyleOnTag(opening, "color", change.value);
      if (!next) continue;
      content = replaceTagAt(content, tag, next);
      tag = { start: tag.start, end: tag.start + next.length, tag: next };
      opening = next;
      touched = true;
      continue;
    }
  }

  if (!touched) return null;
  return content;
}

function replaceTagAt(
  content: string,
  tag: { start: number; end: number },
  next: string,
): string {
  return content.slice(0, tag.start) + next + content.slice(tag.end);
}

function isContainerTag(tag: string): boolean {
  return /<(Pressable|View|TouchableOpacity)\b/.test(tag);
}

/** Patch background on a container testID, or the card wrapping a Text testID. */
function patchBackgroundByTestId(
  content: string,
  testId: string,
  color: string,
): string | null {
  if (!testId || isBroadContainerTestId(testId)) return null;

  const mapPatched = patchMapItemBackground(content, testId, "backgroundColor", color);
  if (mapPatched) return mapPatched;

  const el = findOpeningTagAtTestId(content, testId);
  if (!el) return null;

  if (isContainerTag(el.tag)) {
    const patched = patchStyleOnTag(el.tag, "backgroundColor", color);
    if (!patched) return null;
    return replaceTagAt(content, el, patched);
  }

  const container = findSmallestContainerBefore(content, el.end);
  if (!container) return null;
  const patched = patchStyleOnTag(container.tag, "backgroundColor", color);
  if (!patched) return null;
  return replaceTagAt(content, container, patched);
}

/**
 * Items rendered via `.map()` share one JSX block — patch a per-item conditional
 * style so only the tapped row/card changes (e.g. only Tuesday turns purple).
 */
function patchMapItemBackground(
  content: string,
  testId: string,
  prop: StyleProp,
  color: string,
): string | null {
  const dayValue = testId.match(/-([A-Za-z][A-Za-z0-9]*)$/)?.[1];
  if (!dayValue) return null;

  const templateEl = findTemplateTestIdElement(content, testId);
  if (!templateEl) return null;

  const mapParam = findMapIteratorParamBefore(content, templateEl.start);
  if (!mapParam) return null;

  const target =
    prop === "color" && /<Text\b/.test(templateEl.tag)
      ? templateEl
      : isContainerTag(templateEl.tag)
        ? templateEl
        : findSmallestContainerBefore(content, templateEl.end);
  if (!target) return null;

  const conditional = `{ ${mapParam} === '${dayValue}' && { ${prop}: '${color}' } }`;
  const patched = appendConditionalStyle(target.tag, conditional, prop, mapParam, dayValue);
  if (!patched) return null;
  return replaceTagAt(content, target, patched);
}

function findTemplateTestIdElement(
  content: string,
  testId: string,
): { start: number; end: number; tag: string } | null {
  const dynamic = testId.match(/^(.+)-([A-Za-z][A-Za-z0-9]*)$/);
  if (!dynamic) return null;
  const prefix = dynamic[1];
  const markers = [`\`${prefix}-\${`, `\`${prefix}-$`];

  for (const marker of markers) {
    let from = 0;
    while (from < content.length) {
      const idx = content.indexOf(marker, from);
      if (idx === -1) break;
      from = idx + marker.length;
      const tag = walkBackToOpeningTag(content, idx);
      if (tag?.tag.includes("testID")) return tag;
    }
  }
  return null;
}

function findMapIteratorParamBefore(content: string, elStart: number): string | null {
  const windowStart = Math.max(0, elStart - 900);
  const before = content.slice(windowStart, elStart);
  const m = before.match(/\.map\(\s*\(\s*(\w+)\s*\)\s*=>/);
  return m?.[1] ?? null;
}

function appendConditionalStyle(
  tag: string,
  conditional: string,
  prop: StyleProp,
  mapParam: string,
  dayValue: string,
): string | null {
  const styleRange = findStyleAttribute(tag);
  if (!styleRange) {
    const insertAt = tag.lastIndexOf(tag.trimEnd().endsWith("/>") ? "/>" : ">");
    if (insertAt === -1) return null;
    return `${tag.slice(0, insertAt)} style={[${conditional}]}${tag.slice(insertAt)}`;
  }

  const inner = tag.slice(styleRange.innerStart, styleRange.innerEnd).trim();
  const cleaned = stripConditionalStyle(inner, prop, mapParam, dayValue);
  let replacement: string;
  if (cleaned.startsWith("[")) {
    const body = cleaned.replace(/^\[|\]$/g, "").trim();
    replacement = body ? `[${body}, ${conditional}]` : `[${conditional}]`;
  } else if (cleaned.startsWith("{")) {
    replacement = `[${cleaned}, ${conditional}]`;
  } else {
    replacement = `[${cleaned}, ${conditional}]`;
  }

  return (
    tag.slice(0, styleRange.innerStart) +
    replacement +
    tag.slice(styleRange.innerEnd)
  );
}

function stripConditionalStyle(
  styleExpr: string,
  prop: StyleProp,
  mapParam: string,
  dayValue: string,
): string {
  const re = new RegExp(
    `,\\s*\\{\\s*${mapParam}\\s*===\\s*['"]${dayValue}['"]\\s*&&\\s*\\{\\s*${prop}\\s*:[^}]+\\}\\s*\\}`,
    "g",
  );
  return styleExpr.replace(re, "");
}

function patchTextColorByTestId(
  content: string,
  testId: string,
  color: string,
): string | null {
  if (!testId || isBroadContainerTestId(testId)) return null;

  const mapPatched = patchMapItemBackground(content, testId, "color", color);
  if (mapPatched) return mapPatched;

  const el = findOpeningTagAtTestId(content, testId);
  if (!el) return null;

  const patched = patchStyleOnTag(el.tag, "color", color);
  if (!patched) return null;
  return replaceTagAt(content, el, patched);
}

function patchBackgroundNearText(
  content: string,
  anchorText: string,
  color: string,
  boxTestId?: string | null,
): string | null {
  if (boxTestId && !isBroadContainerTestId(boxTestId)) {
    const byId = findOpeningTagAtTestId(content, boxTestId);
    if (byId && /<(Pressable|View|TouchableOpacity)\b/.test(byId.tag)) {
      const patched = patchStyleOnTag(byId.tag, "backgroundColor", color);
      if (patched) {
        return content.slice(0, byId.start) + patched + content.slice(byId.end);
      }
    }
  }

  const anchorIdx = findAnchorIndex(content, anchorText);
  if (anchorIdx === -1) return null;

  const container = findSmallestContainerBefore(content, anchorIdx);
  if (!container) return null;

  const patched = patchStyleOnTag(container.tag, "backgroundColor", color);
  if (!patched) return null;
  return content.slice(0, container.start) + patched + content.slice(container.end);
}

function findAnchorIndex(content: string, anchorText: string): number {
  const escaped = anchorText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`>\\s*${escaped}\\s*<`, "gu"),
    new RegExp(`\\{\\s*["']${escaped}["']\\s*\\}`, "gu"),
    new RegExp(`["']${escaped}["']`, "gu"),
  ];
  const hits: number[] = [];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m.index !== undefined) hits.push(m.index);
    }
  }
  if (hits.length === 0) return content.indexOf(anchorText);

  // Prefer JSX text over the same word in a string array (e.g. DAYS = ["Tue"]).
  const jsxHits = hits.filter((idx) => {
    const before = content.slice(Math.max(0, idx - 600), idx);
    return />[\s\S]*$/.test(before) || before.includes(".map(");
  });
  return jsxHits.length > 0 ? jsxHits[jsxHits.length - 1]! : hits[hits.length - 1]!;
}

function patchTextColorNearText(
  content: string,
  anchorText: string,
  color: string,
): string | null {
  const anchorIdx = findAnchorIndex(content, anchorText);
  if (anchorIdx === -1) return null;

  const textTag = findTextTagBefore(content, anchorIdx) ?? findContainerTagBefore(content, anchorIdx);
  if (!textTag) return null;

  const patched = patchStyleOnTag(textTag.tag, "color", color);
  if (!patched) return null;
  return content.slice(0, textTag.start) + patched + content.slice(textTag.end);
}

function findTextTagBefore(
  content: string,
  anchorIndex: number,
): { start: number; end: number; tag: string } | null {
  const windowStart = Math.max(0, anchorIndex - 1500);
  const before = content.slice(windowStart, anchorIndex);
  const tagRe = /<Text\b/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(before)) !== null) {
    last = m;
  }
  if (!last || last.index === undefined) return null;

  const absStart = windowStart + last.index;
  let end = absStart + 1;
  let quote: string | null = null;
  while (end < content.length) {
    const c = content[end];
    if (quote) {
      if (c === quote && content[end - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === ">") {
      end++;
      break;
    }
    end++;
  }
  return { start: absStart, end, tag: content.slice(absStart, end) };
}

function parseOpeningTagAt(
  content: string,
  start: number,
): { start: number; end: number; tag: string } | null {
  if (content[start] !== "<") return null;
  let end = start + 1;
  let quote: string | null = null;
  while (end < content.length) {
    const c = content[end];
    if (quote) {
      if (c === quote && content[end - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === ">") {
      end++;
      break;
    }
    end++;
  }
  return { start, end, tag: content.slice(start, end) };
}

function findContainerTagBefore(
  content: string,
  anchorIndex: number,
): { start: number; end: number; tag: string } | null {
  return findSmallestContainerBefore(content, anchorIndex);
}

/** Innermost card-sized container wrapping the anchor text. */
function findSmallestContainerBefore(
  content: string,
  anchorIndex: number,
): { start: number; end: number; tag: string } | null {
  const windowStart = Math.max(0, anchorIndex - 3000);
  const before = content.slice(windowStart, anchorIndex);
  const tagRe = /<(Pressable|View|TouchableOpacity)\b/g;
  let best: { start: number; end: number; tag: string } | null = null;
  let bestSpan = Infinity;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(before)) !== null) {
    if (m.index === undefined) continue;
    const absStart = windowStart + m.index;
    const parsed = parseOpeningTagAt(content, absStart);
    if (!parsed) continue;
    const span = anchorIndex - absStart;
    if (span < 10 || span > 4500) continue;
    const testId = extractTestIdFromTag(parsed.tag);
    if (testId && isBroadContainerTestId(testId)) continue;
    if (span < bestSpan) {
      bestSpan = span;
      best = parsed;
    }
  }
  return best;
}

function stripEmoji(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\uFE0F/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function patchTextReplaceInScope(
  content: string,
  tag: { start: number; end: number },
  oldText: string,
  newText: string,
): string | null {
  const scopeStart = tag.start;
  const scopeEnd = Math.min(content.length, scopeStart + 5000);
  const slice = content.slice(scopeStart, scopeEnd);

  const needles = [oldText, stripEmoji(oldText)].filter(
    (v, i, arr) => Boolean(v) && arr.indexOf(v) === i,
  );

  for (const needle of needles) {
    const patched = replaceExactTextNeedle(slice, needle, newText);
    if (patched) {
      return content.slice(0, scopeStart) + patched + content.slice(scopeEnd);
    }
  }

  const fuzzy = replaceLiteralNearOldText(slice, oldText, newText);
  if (fuzzy) {
    return content.slice(0, scopeStart) + fuzzy + content.slice(scopeEnd);
  }

  const emojiOnly = removeEmojiFromScope(slice, oldText, newText);
  if (emojiOnly) {
    return content.slice(0, scopeStart) + emojiOnly + content.slice(scopeEnd);
  }

  return null;
}

/** Preview had emoji but source stores it separately or inline — user removed it. */
function removeEmojiFromScope(slice: string, oldText: string, newText: string): string | null {
  if (stripEmoji(oldText) !== newText.trim()) return null;

  let hit = false;
  let out = slice;

  out = out.replace(/\{\s*["'][\p{Extended_Pictographic}\uFE0F\s]+["']\s*\}/gu, () => {
    hit = true;
    return "";
  });

  out = out.replace(/>([^<]*)[\p{Extended_Pictographic}\uFE0F]+([^<]*)</gu, (_m, a: string, b: string) => {
    hit = true;
    return `>${a}${b}<`;
  });

  out = out.replace(/(["'`])([^"'`]*)\1/gu, (full, quote: string, inner: string) => {
    const trimmed = inner
      .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (trimmed !== inner) {
      hit = true;
      return `${quote}${trimmed}${quote}`;
    }
    return full;
  });

  return hit ? out : null;
}

function replaceExactTextNeedle(slice: string, needle: string, newText: string): string | null {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(>\\s*)${escaped}(\\s*<)`, "u"),
    new RegExp(`(["'])${escaped}\\1`, "u"),
    new RegExp(`(\`)${escaped}\\1`, "u"),
    new RegExp(`(\\{\\s*["'])${escaped}(["']\\s*\\})`, "u"),
  ];

  for (const re of patterns) {
    if (!re.test(slice)) continue;
    let hit = false;
    const patched = slice.replace(re, (_m, a: string, b: string) => {
      hit = true;
      return `${a}${newText}${b}`;
    });
    if (hit) return patched;
  }
  return null;
}

/** When preview text includes an emoji but source stores plain text in quotes. */
function replaceLiteralNearOldText(
  slice: string,
  oldText: string,
  newText: string,
): string | null {
  const oldCore = stripEmoji(oldText) || oldText;
  const literalRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let hit = false;
  const patched = slice.replace(literalRe, (full, quote: string, inner: string) => {
    if (hit) return full;
    const innerCore = stripEmoji(inner);
    const matches =
      inner === oldText ||
      innerCore === oldCore ||
      (oldCore.length > 2 && innerCore.includes(oldCore)) ||
      (innerCore.length > 2 && oldCore.includes(innerCore));
    if (!matches) return full;
    hit = true;
    return `${quote}${newText}${quote}`;
  });
  return hit ? patched : null;
}

function walkBackToOpeningTag(
  content: string,
  idx: number,
): { start: number; end: number; tag: string } | null {
  let start = idx;
  while (start > 0 && content[start] !== "<") start--;
  if (content[start] !== "<") return null;

  let end = start + 1;
  let quote: string | null = null;
  while (end < content.length) {
    const c = content[end];
    if (quote) {
      if (c === quote && content[end - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === ">") {
      end++;
      break;
    }
    end++;
  }

  return { start, end, tag: content.slice(start, end) };
}

function findOpeningTagAtTestId(
  content: string,
  testId: string,
): { start: number; end: number; tag: string } | null {
  const needles = [
    `testID="${testId}"`,
    `testID='${testId}'`,
    `testID={"${testId}"}`,
    `testID={'${testId}'}`,
    `testID={\`${testId}\`}`,
  ];

  let idx = -1;
  for (const needle of needles) {
    const i = content.indexOf(needle);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx !== -1) {
    const tag = walkBackToOpeningTag(content, idx);
    if (tag) return tag;
  }

  // Runtime IDs from templates like `week-day-${day}` → week-day-Tue
  const dynamic = testId.match(/^(.+)-([A-Za-z][A-Za-z0-9]*)$/);
  if (dynamic) {
    const prefix = dynamic[1];
    const suffix = dynamic[2];
    const templateMarkers = [
      `testID={\`${prefix}-\${`,
      `testID={\`${prefix}$\{`,
      `testID={\`${prefix}-\${`,
      `\`${prefix}-\${`,
    ];
    for (const marker of templateMarkers) {
      let from = 0;
      while (from < content.length) {
        const tIdx = content.indexOf(marker, from);
        if (tIdx === -1) break;
        from = tIdx + marker.length;
        const tag = walkBackToOpeningTag(content, tIdx);
        if (!tag) continue;
        const scopeEnd = Math.min(content.length, tag.end + 1200);
        const scope = content.slice(tag.end, scopeEnd);
        const suffixNeedles = [
          `>${suffix}<`,
          `>${suffix}</`,
          `"${suffix}"`,
          `'${suffix}'`,
          `{\`${suffix}\`}`,
          `{${suffix}}`,
        ];
        if (suffixNeedles.some((n) => scope.includes(n))) return tag;
      }
    }
  }

  return null;
}

function patchStyleOnTag(tag: string, prop: StyleProp, value: string): string | null {
  const override = formatStyleOverride(prop, value);
  const styleRange = findStyleAttribute(tag);

  if (!styleRange) {
    const insertAt = tag.lastIndexOf(tag.trimEnd().endsWith("/>") ? "/>" : ">");
    if (insertAt === -1) return null;
    return `${tag.slice(0, insertAt)} style={[${override}]}${tag.slice(insertAt)}`;
  }

  const inner = tag.slice(styleRange.innerStart, styleRange.innerEnd).trim();
  let replacement: string;

  if (inner.startsWith("[")) {
    const withoutOld = stripStyleOverrideFromArray(inner, prop);
    const body = withoutOld.replace(/^\[|\]$/g, "").trim();
    replacement = body ? `[${body}, ${override}]` : `[${override}]`;
  } else if (inner.startsWith("{")) {
    replacement = mergeStyleObject(inner, prop, value);
  } else {
    replacement = `[${inner}, ${override}]`;
  }

  return (
    tag.slice(0, styleRange.innerStart) +
    replacement +
    tag.slice(styleRange.innerEnd)
  );
}

function formatStyleOverride(prop: StyleProp, value: string): string {
  return `{ ${prop}: '${value}' }`;
}

function findStyleAttribute(
  tag: string,
): { innerStart: number; innerEnd: number } | null {
  const marker = "style=";
  const idx = tag.indexOf(marker);
  if (idx === -1) return null;

  const braceStart = tag.indexOf("{", idx + marker.length);
  if (braceStart === -1) return null;

  let depth = 0;
  let quote: string | null = null;
  for (let i = braceStart; i < tag.length; i++) {
    const c = tag[i];
    if (quote) {
      if (c === quote && tag[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return { innerStart: braceStart + 1, innerEnd: i };
      }
    }
  }
  return null;
}

function stripStyleOverrideFromArray(arrayExpr: string, prop: StyleProp): string {
  const re = new RegExp(
    `,\\s*\\{\\s*${prop}\\s*:\\s*['"\`][^'"\`]*['"\`]\\s*\\}`,
    "g",
  );
  return arrayExpr.replace(re, "");
}

function mergeStyleObject(objExpr: string, prop: StyleProp, value: string): string {
  const body = objExpr.replace(/^\{|\}$/g, "").trim();
  const propRe = new RegExp(`${prop}\\s*:\\s*[^,}]+`);
  if (propRe.test(body)) {
    return `{ ${body.replace(propRe, `${prop}: '${value}'`)} }`;
  }
  const suffix = body ? `${body}, ${prop}: '${value}'` : `${prop}: '${value}'`;
  return `{ ${suffix} }`;
}

function patchTextContent(content: string, tag: TagSpan, newText: string): string | null {
  const opening = content.slice(tag.start, tag.end);
  if (opening.trimEnd().endsWith("/>")) return null;

  const tagName = opening.match(/^<(\w+)/)?.[1];
  if (!tagName) return null;

  const closeRe = new RegExp(`</${tagName}>`, "g");
  closeRe.lastIndex = tag.end;
  const close = closeRe.exec(content);
  if (!close) return null;

  const inner = content.slice(tag.end, close.index);
  if (inner.includes("{")) return null;

  return content.slice(0, tag.end) + newText + content.slice(close.index);
}

interface TagSpan {
  start: number;
  end: number;
}

function tapEditSummary(changes: TapEditChange[]): string {
  const parts: string[] = [];
  for (const c of changes) {
    if (c.type === "text" && c.oldValue) {
      parts.push(`"${c.oldValue}" is now "${c.value}"`);
    } else if (c.type === "text") {
      parts.push(`the text is now "${c.value}"`);
    } else if (c.type === "color") {
      parts.push("the text color is updated");
    } else if (c.type === "background") {
      parts.push("the background color is updated");
    }
  }
  if (parts.length === 0) return "Done - your change is in!";
  if (parts.length === 1) return `Done - ${parts[0]}.`;
  return `Done - ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

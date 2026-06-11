import { emit } from "../events.js";
import { listProjectFiles, readProjectFile, writeProjectFile } from "../orchestrator.js";

type StyleProp = "color" | "backgroundColor";

export interface TapEditChange {
  type: "text" | "color" | "background" | "removeIcon";
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
    const removeIconScoped = part.match(
      /^remove the icon from the container for "(.+)"$/u,
    );
    if (removeIconScoped) {
      changes.push({
        type: "removeIcon",
        value: "",
        anchorText: removeIconScoped[1],
      });
      continue;
    }
    if (part === "remove the icon from this element") {
      changes.push({ type: "removeIcon", value: "" });
      continue;
    }
    const replace = part.match(/^replace the text "(.+)" with "(.*)"$/u);
    if (replace) {
      changes.push({ type: "text", oldValue: replace[1], value: replace[2] });
      continue;
    }
    const text = part.match(/^set the text to "(.*)"$/u);
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
      c.type === "removeIcon" ||
      (c.type === "text" && c.oldValue),
  );
  if (!hasWork) return { ok: false };

  const hasAnchor = parsed.changes.some((c) => c.anchorText);
  const hasTextReplace = parsed.changes.some((c) => c.type === "text" && c.oldValue);
  const hasIconRemoval = parsed.changes.some((c) => c.type === "removeIcon");
  const effectiveTestId =
    parsed.testId && !isBroadContainerTestId(parsed.testId) ? parsed.testId : "";
  if (!effectiveTestId && !hasAnchor && !hasTextReplace && !hasIconRemoval) {
    return { ok: false };
  }

  let candidates = await findCandidateFiles(projectId, parsed.testId, parsed.changes);
  if (candidates.length === 0 && hasTextReplace) {
    candidates = await allTsxFiles(projectId);
  }

  const tried = new Set<string>();
  for (const file of candidates) {
    tried.add(file);
    const content = await readProjectFile(projectId, file);
    const updated = patchTapEditInFile(content, effectiveTestId, parsed.changes);
    if (updated && updated !== content && looksLikeValidSource(updated)) {
      await writeProjectFile(projectId, file, updated);
      emit(projectId, { type: "file.op", op: "write", path: file });
      return { ok: true, summary: tapEditSummary(parsed.changes), file };
    }
  }

  // Last resort: only when we have no testID — never global-replace with a scoped tap.
  if (hasTextReplace && !effectiveTestId) {
    for (const file of await allTsxFiles(projectId)) {
      if (tried.has(file)) continue;
      const content = await readProjectFile(projectId, file);
      const updated = patchTapEditInFile(content, "", parsed.changes);
      if (updated && updated !== content && looksLikeValidSource(updated)) {
        await writeProjectFile(projectId, file, updated);
        emit(projectId, { type: "file.op", op: "write", path: file });
        return { ok: true, summary: tapEditSummary(parsed.changes), file };
      }
    }
  }

  emit(projectId, {
    type: "build.event",
    level: "warn",
    source: "system",
    text: `tap-edit: could not patch source for ${request.slice(0, 100)}`,
  });
  return { ok: false };
}

/** Reject patches that would obviously break TSX before we write them. */
function looksLikeValidSource(src: string): boolean {
  const singles = (src.match(/'/g) ?? []).length;
  if (singles % 2 !== 0) return false;
  const doubles = (src.match(/"/g) ?? []).length;
  if (doubles % 2 !== 0) return false;
  // Broken ternary string: ? "foo : day}  (missing closing quote)
  if (/\?\s*"[^"\n]*:\s*\w+\}/.test(src)) return false;
  return true;
}

/** Apply a tap-edit message to source text (for tests and debugging). */
export function applyTapEditToSource(content: string, request: string): string | null {
  const parsed = parseTapEditRequest(request);
  if (!parsed) return null;
  const testId =
    parsed.testId && !isBroadContainerTestId(parsed.testId) ? parsed.testId : "";
  return patchTapEditInFile(content, testId, parsed.changes);
}

async function allTsxFiles(projectId: string): Promise<string[]> {
  const files = await listProjectFiles(projectId);
  return files.filter((f) => /\.(tsx|jsx)$/.test(f));
}

async function findCandidateFiles(
  projectId: string,
  testId: string | null,
  changes: TapEditChange[],
): Promise<string[]> {
  const hits = new Set<string>();

  const specificTestId =
    testId && !isBroadContainerTestId(testId) ? testId : null;
  if (specificTestId) {
    for (const f of await findFilesWithTestId(projectId, specificTestId)) hits.add(f);
  }

  const anchor = changes.find((c) => c.anchorText)?.anchorText;
  if (anchor) {
    for (const f of await findFilesContainingText(projectId, anchor)) hits.add(f);
  }

  for (const change of changes) {
    if (change.type === "text" && change.oldValue) {
      for (const f of await findFilesContainingText(projectId, change.oldValue)) {
        hits.add(f);
      }
    }
  }

  if (testId && isBroadContainerTestId(testId)) {
    for (const f of await findFilesWithTestId(projectId, testId)) hits.add(f);
  }

  return [...hits];
}

async function findFilesWithTestId(projectId: string, testId: string): Promise<string[]> {
  const files = await listProjectFiles(projectId);
  const hits: string[] = [];
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dynamicRe = new RegExp(`testID=\\{[^}]*${escaped}`);
  const needles = [
    `testID="${testId}"`,
    `testID='${testId}'`,
    `testID={\`${testId}\`}`,
    `testID={\`${testId}`,
    `testID={"${testId}"}`,
    `testID={'${testId}'}`,
  ];
  for (const file of files) {
    if (!/\.(tsx|jsx)$/.test(file)) continue;
    const content = await readProjectFile(projectId, file);
    if (needles.some((n) => content.includes(n)) || dynamicRe.test(content)) {
      hits.push(file);
    }
  }
  return hits;
}

function extractTestIdFromTag(tag: string): string | null {
  const m = tag.match(/testID=(?:"([^"]+)"|'([^']+)'|\{["']([^"']+)["']\})/);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

function isBroadContainerTestId(testId: string): boolean {
  const id = testId.toLowerCase();
  const exact = new Set([
    "screen",
    "scroll",
    "scrollview",
    "root",
    "layout",
    "wrapper",
    "container",
    "page",
    "app",
    "content",
    "section",
    "header",
    "home-screen",
    "home-scroll",
    "home-root",
    "home-layout",
    "home-wrapper",
    "home-container",
    "home-page",
    "home-content",
    "home-section",
    "home-header",
  ]);
  if (exact.has(id)) return true;
  if (/^home-(screen|scroll|root|layout|wrapper|container|page|content|section|header)/.test(id)) {
    return true;
  }
  if (/-(screen|scrollview|scroll-view|root|layout|wrapper|container|page)$/.test(id)) {
    return true;
  }
  return false;
}

async function findFilesContainingText(
  projectId: string,
  text: string,
): Promise<string[]> {
  const needles = [text, stripEmoji(text)].filter(
    (v, i, arr) => Boolean(v) && arr.indexOf(v) === i,
  );
  const files = await listProjectFiles(projectId);
  const tsx = files.filter((f) => /\.(tsx|jsx)$/.test(f));
  const hits: string[] = [];
  for (const file of tsx) {
    const content = await readProjectFile(projectId, file);
    if (needles.some((n) => content.includes(n))) hits.push(file);
  }
  return hits;
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
    if (change.type === "removeIcon") {
      const removed = patchRemoveIconInFile(content, testId, change.anchorText);
      if (!removed) return null;
      content = removed;
      tag = testId ? findOpeningTagAtTestId(content, testId) : tag;
      if (tag) opening = tag.tag;
      touched = true;
      continue;
    }

    if (change.type === "text" && change.oldValue) {
      const replaced = patchTextReplaceWithTestId(
        content,
        testId,
        change.oldValue,
        change.value,
      );
      if (!replaced) return null;
      content = replaced;
      tag = testId ? findOpeningTagAtTestId(content, testId) : tag;
      if (tag) opening = tag.tag;
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
      if (testId) {
        patchedColor = patchTextColorByTestId(
          content,
          testId,
          change.value,
          change.anchorText,
        );
      }
      if (!patchedColor && change.anchorText && !testId) {
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

/** Split `meal-plan-mon` → prefix `meal-plan`, suffix `mon` (last segment only). */
function splitDynamicTestId(testId: string): { prefix: string; suffix: string } | null {
  const idx = testId.lastIndexOf("-");
  if (idx <= 0) return null;
  const suffix = testId.slice(idx + 1);
  const prefix = testId.slice(0, idx);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(suffix) || !prefix) return null;
  return { prefix, suffix };
}

function detectPropNameFromTestIdTemplate(tag: string): string | null {
  const m = tag.match(/\$\{(\w+)(?:\.toLowerCase\(\)|\.toUpperCase\(\))?\}/);
  return m?.[1] ?? null;
}

/** Map runtime suffix `mon` → source prop value `Mon`. */
function resolvePropValueFromTestIdSuffix(content: string, suffix: string): string {
  const re = /['"]([A-Za-z][A-Za-z0-9]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1].toLowerCase() === suffix.toLowerCase()) return m[1];
  }
  return suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase();
}

function findComponentBodyStart(content: string, pos: number): number {
  const windowStart = Math.max(0, pos - 2000);
  const before = content.slice(windowStart, pos);
  const re = /\)\s*=>\s*\{/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before)) !== null) {
    last = m;
  }
  if (last?.index !== undefined) {
    return windowStart + last.index + last[0].length;
  }
  return -1;
}

function readContainerSubtree(
  content: string,
  el: { start: number; end: number; tag: string },
): { slice: string; offset: number; closeIndex: number } | null {
  const tagName = el.tag.match(/^<(\w+)/)?.[1];
  if (!tagName) return null;
  const closeRe = new RegExp(`</${tagName}>`, "g");
  closeRe.lastIndex = el.end;
  const close = closeRe.exec(content);
  if (!close) return null;
  return { slice: content.slice(el.end, close.index), offset: el.end, closeIndex: close.index };
}

function findTextChildWithPropRef(
  slice: string,
  propName: string,
): { innerStart: number; innerEnd: number } | null {
  const re = /<Text\b[^>]*>([\s\S]*?)<\/Text>/g;
  let m: RegExpExecArray | null;
  const propRef = new RegExp(`^\\{\\s*${propName}\\s*\\}$`);
  while ((m = re.exec(slice)) !== null) {
    const inner = m[1];
    const trimmed = inner.trim();
    if (propRef.test(trimmed)) {
      const innerStart = m.index + m[0].indexOf(inner);
      return { innerStart, innerEnd: innerStart + inner.length };
    }
  }
  return null;
}

/** Matches `[styles.card, { backgroundColor: '...' }]` including newlines. */
const CARD_BG_BRANCH =
  "\\[styles\\.card,\\s*\\{\\s*backgroundColor:\\s*['\"][^'\"]*['\"]\\s*\\}\\]";

function escapeStyleRefForRegex(styleRef: string): string {
  return styleRef.replace(/\./g, "\\.");
}

function textColorBranchPattern(styleRef: string): string {
  return `\\[${escapeStyleRefForRegex(styleRef)},\\s*\\{\\s*color:\\s*['\"][^'\"]*['\"]\\s*\\}\\]`;
}

function removePropKeyedStyleBranch(
  expr: string,
  propName: string,
  propValue: string,
  branchPattern: string,
): string {
  const esc = propValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const removeRe = new RegExp(
    `${propName}\\s*===\\s*['"]${esc}['"]\\s*\\?\\s*${branchPattern}\\s*:\\s*`,
    "g",
  );
  return expr.replace(removeRe, "").trim();
}

function removeCardStyleBranch(
  expr: string,
  propName: string,
  propValue: string,
): string {
  return removePropKeyedStyleBranch(expr, propName, propValue, CARD_BG_BRANCH);
}

function upsertTernaryBranch(
  expr: string,
  propName: string,
  propValue: string,
  branch: string,
  defaultStyle: string,
  branchPattern: string = CARD_BG_BRANCH,
): string {
  const cleaned = removePropKeyedStyleBranch(expr, propName, propValue, branchPattern);
  if (!cleaned || cleaned === defaultStyle) {
    return `${branch} : ${defaultStyle}`;
  }
  return `${branch} : ${cleaned}`;
}

function resolveLabelStyleRefs(styleRef: string): { varName: string; defaultStyle: string } {
  if (styleRef.startsWith("styles.")) {
    const base = styleRef.replace(/^styles\./, "");
    return { varName: `${base}TextStyle`, defaultStyle: styleRef };
  }
  if (styleRef.endsWith("TextStyle")) {
    const base = styleRef.slice(0, -"TextStyle".length);
    return { varName: styleRef, defaultStyle: `styles.${base}` };
  }
  return { varName: `${styleRef}TextStyle`, defaultStyle: styleRef };
}

/**
 * Components like MealPlanCard receive `day` as a prop and use
 * testID={`meal-plan-${day.toLowerCase()}`}. Background must be per-day,
 * not one inline style on the shared JSX.
 */
function patchPropKeyedBackground(
  content: string,
  testId: string,
  color: string,
): string | null {
  const dynamic = splitDynamicTestId(testId);
  if (!dynamic) return null;

  const templateEl = findTemplateTestIdElement(content, testId);
  if (!templateEl || !isContainerTag(templateEl.tag)) return null;

  const propName = detectPropNameFromTestIdTemplate(templateEl.tag);
  if (!propName) return null;

  const propValue = resolvePropValueFromTestIdSuffix(content, dynamic.suffix);
  const branch = `${propName} === '${propValue}' ? [styles.card, { backgroundColor: '${color}' }]`;
  return upsertCardStyleVariable(content, templateEl, propName, propValue, branch);
}

function upsertCardStyleVariable(
  content: string,
  templateEl: { start: number; end: number; tag: string },
  propName: string,
  propValue: string,
  branch: string,
): string | null {
  const bodyStart = findComponentBodyStart(content, templateEl.start);
  if (bodyStart === -1) return null;

  const returnIdx = content.indexOf("return (", bodyStart);
  if (returnIdx === -1 || returnIdx > templateEl.start) return null;

  const beforeReturn = content.slice(bodyStart, returnIdx);
  const cardStyleRe = /const\s+cardStyle\s*=\s*([\s\S]*?);\s*\n/;
  const cardStyleMatch = beforeReturn.match(cardStyleRe);
  const defaultStyle = "styles.card";

  let updated = content;

  if (cardStyleMatch) {
    const expr = upsertTernaryBranch(
      cardStyleMatch[1].trim(),
      propName,
      propValue,
      branch,
      defaultStyle,
    );
    const absMatchStart = bodyStart + beforeReturn.indexOf(cardStyleMatch[0]);
    const newDecl = `const cardStyle = ${expr};\n`;
    updated =
      updated.slice(0, absMatchStart) +
      newDecl +
      updated.slice(absMatchStart + cardStyleMatch[0].length);
  } else {
    const expr = `${branch} : ${defaultStyle}`;
    const tag = content.slice(templateEl.start, templateEl.end);
    let newTag = tag;
    if (tag.includes("style={styles.card}")) {
      newTag = tag.replace("style={styles.card}", "style={cardStyle}");
    } else if (!tag.includes("style={cardStyle}")) {
      const insertAt = newTag.lastIndexOf(newTag.trimEnd().endsWith("/>") ? "/>" : ">");
      if (insertAt === -1) return null;
      newTag = `${newTag.slice(0, insertAt)} style={cardStyle}${newTag.slice(insertAt)}`;
    }
    updated =
      content.slice(0, templateEl.start) + newTag + content.slice(templateEl.end);

    const returnAfterTag = updated.indexOf("return (", bodyStart);
    if (returnAfterTag === -1) return null;
    const indent = updated.slice(bodyStart, returnAfterTag).match(/(\n\s*)$/)?.[1] ?? "\n  ";
    const newDecl = `${indent}const cardStyle = ${expr};\n\n${indent}`;
    updated = updated.slice(0, returnAfterTag) + newDecl + updated.slice(returnAfterTag);
  }

  return updated;
}

function findTextOpeningWithPropRef(
  content: string,
  containerEl: { start: number; end: number; tag: string },
  propName: string,
): { start: number; end: number; tag: string; styleRef: string } | null {
  const subtree = readContainerSubtree(content, containerEl);
  if (!subtree) return null;

  const re = /<Text\b([^>]*)>([\s\S]*?)<\/Text>/g;
  const propOnly = new RegExp(`^\\{\\s*${propName}\\s*\\}$`);
  const propDriven = new RegExp(`\\{\\s*${propName}\\s*===`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(subtree.slice)) !== null) {
    const trimmed = (m[2] ?? "").trim();
    if (!propOnly.test(trimmed) && !propDriven.test(trimmed)) continue;
    const attrs = m[1] ?? "";
    const styleMatch = attrs.match(/style=\{([^{}]+)\}/);
    if (!styleMatch) continue;
    const styleRef = styleMatch[1].trim();
    const absStart = subtree.offset + (m.index ?? 0);
    const parsed = parseOpeningTagAt(content, absStart);
    if (!parsed) continue;
    return { ...parsed, styleRef };
  }
  return null;
}

/**
 * Text color on labels like `<Text style={styles.day}>{day}</Text>` inside
 * `testID={\`meal-plan-${day}\`}` cards — per-day ternary, never on the card box.
 */
function anchorMatchesKeyedProp(
  anchorText: string,
  propValue: string,
  inner: string,
): boolean {
  const a = (stripEmoji(anchorText) || anchorText).trim().toLowerCase();
  const pv = propValue.toLowerCase();
  if (a === pv || a.startsWith(pv) || pv.startsWith(a)) return true;
  const display = inner.match(/\?\s*"([^"]+)"/)?.[1];
  if (display && display.trim().toLowerCase() === a) return true;
  return false;
}

function textInnerMatchesAnchor(inner: string, anchorText: string): boolean {
  const trimmed = inner.trim();
  const a = (stripEmoji(anchorText) || anchorText).trim();
  if (!a) return false;
  if (trimmed.includes(a)) return true;
  const quoted = new RegExp(`["']${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
  if (quoted.test(trimmed)) return true;
  const propRef = trimmed.match(/^\{\s*(\w+)\s*\}$/);
  if (propRef) {
    const name = propRef[1];
    if (name === "date" && /\d{1,2}\/\d{1,2}/.test(a)) return true;
    if (name === "day" && /^[A-Za-z]{3}/.test(a)) return true;
  }
  return false;
}

function patchTextColorInContainerByAnchor(
  content: string,
  testId: string,
  anchorText: string,
  color: string,
): string | null {
  const container = findOpeningTagAtTestId(content, testId);
  if (!container) return null;
  const subtree = readContainerSubtree(content, container);
  if (!subtree) return null;

  const re = /<Text\b([^>]*)>([\s\S]*?)<\/Text>/g;
  let m: RegExpExecArray | null;
  let hit: { start: number; end: number; tag: string } | null = null;
  while ((m = re.exec(subtree.slice)) !== null) {
    const inner = (m[2] ?? "").trim();
    if (!textInnerMatchesAnchor(inner, anchorText)) continue;
    const absStart = subtree.offset + (m.index ?? 0);
    const parsed = parseOpeningTagAt(content, absStart);
    if (parsed) hit = parsed;
  }
  if (!hit) return null;

  const patched = patchStyleOnTag(hit.tag, "color", color);
  if (!patched) return null;
  return content.slice(0, hit.start) + patched + content.slice(hit.end);
}

function patchPropKeyedTextColor(
  content: string,
  testId: string,
  color: string,
  anchorText?: string,
): string | null {
  const dynamic = splitDynamicTestId(testId);
  if (!dynamic) return null;

  const templateEl = findTemplateTestIdElement(content, testId);
  if (!templateEl || !isContainerTag(templateEl.tag)) return null;

  const propName = detectPropNameFromTestIdTemplate(templateEl.tag);
  if (!propName) return null;

  const propValue = resolvePropValueFromTestIdSuffix(content, dynamic.suffix);
  const textEl = findTextOpeningWithPropRef(content, templateEl, propName);
  if (!textEl) return null;

  const innerStart = textEl.end;
  const innerEnd = content.indexOf("</Text>", innerStart);
  const inner = innerEnd === -1 ? "" : content.slice(innerStart, innerEnd).trim();
  if (anchorText && !anchorMatchesKeyedProp(anchorText, propValue, inner)) {
    return null;
  }

  const { defaultStyle } = resolveLabelStyleRefs(textEl.styleRef);
  const branch = `${propName} === '${propValue}' ? [${defaultStyle}, { color: '${color}' }]`;
  return upsertTextStyleVariable(
    content,
    templateEl,
    textEl,
    propName,
    propValue,
    branch,
  );
}

function upsertTextStyleVariable(
  content: string,
  templateEl: { start: number; end: number; tag: string },
  textEl: { start: number; end: number; tag: string; styleRef: string },
  propName: string,
  propValue: string,
  branch: string,
): string | null {
  const bodyStart = findComponentBodyStart(content, templateEl.start);
  if (bodyStart === -1) return null;

  const returnIdx = content.indexOf("return (", bodyStart);
  if (returnIdx === -1 || returnIdx > templateEl.start) return null;

  const { varName, defaultStyle } = resolveLabelStyleRefs(textEl.styleRef);
  const branchPattern = textColorBranchPattern(defaultStyle);
  const beforeReturn = content.slice(bodyStart, returnIdx);
  const styleVarRe = new RegExp(`const\\s+${varName}\\s*=\\s*([\\s\\S]*?);\\s*\\n`);
  const styleVarMatch = beforeReturn.match(styleVarRe);

  let updated = content;

  if (styleVarMatch) {
    const expr = upsertTernaryBranch(
      styleVarMatch[1].trim(),
      propName,
      propValue,
      branch,
      defaultStyle,
      branchPattern,
    );
    const absMatchStart = bodyStart + beforeReturn.indexOf(styleVarMatch[0]);
    const newDecl = `const ${varName} = ${expr};\n`;
    updated =
      updated.slice(0, absMatchStart) +
      newDecl +
      updated.slice(absMatchStart + styleVarMatch[0].length);
  } else {
    const expr = `${branch} : ${defaultStyle}`;
    const tag = textEl.tag;
    let newTag = tag;
    if (tag.includes(`style={${defaultStyle}}`)) {
      newTag = tag.replace(`style={${defaultStyle}}`, `style={${varName}}`);
    } else if (!tag.includes(`style={${varName}}`)) {
      return null;
    }
    updated = updated.slice(0, textEl.start) + newTag + content.slice(textEl.end);

    const returnAfterTag = updated.indexOf("return (", bodyStart);
    if (returnAfterTag === -1) return null;
    const indent = updated.slice(bodyStart, returnAfterTag).match(/(\n\s*)$/)?.[1] ?? "\n  ";
    const newDecl = `${indent}const ${varName} = ${expr};\n\n${indent}`;
    updated = updated.slice(0, returnAfterTag) + newDecl + updated.slice(returnAfterTag);
  }

  return updated;
}

/** Text labels driven by a prop ({day}) — never global-replace the display string. */
function patchPropKeyedText(
  content: string,
  testId: string,
  oldText: string,
  newText: string,
): string | null {
  const dynamic = splitDynamicTestId(testId);
  if (!dynamic) return null;

  const templateEl = findTemplateTestIdElement(content, testId);
  if (!templateEl) return null;

  const propName = detectPropNameFromTestIdTemplate(templateEl.tag);
  if (!propName) return null;

  const propValue = resolvePropValueFromTestIdSuffix(content, dynamic.suffix);
  const oldCore = stripEmoji(oldText) || oldText;
  if (
    oldCore.toLowerCase() !== propValue.toLowerCase() &&
    oldText.trim().toLowerCase() !== propValue.toLowerCase()
  ) {
    return null;
  }

  const subtree = readContainerSubtree(content, templateEl);
  if (!subtree) return null;

  const textHit = findTextChildWithPropRef(subtree.slice, propName);
  if (!textHit) return null;

  const inner = `{${propName} === '${propValue}' ? ${JSON.stringify(newText)} : ${propName}}`;
  const absInnerStart = subtree.offset + textHit.innerStart;
  const absInnerEnd = subtree.offset + textHit.innerEnd;
  return content.slice(0, absInnerStart) + inner + content.slice(absInnerEnd);
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

  const propPatched = patchPropKeyedBackground(content, testId, color);
  if (propPatched) return propPatched;

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
  const dynamic = splitDynamicTestId(testId);
  if (!dynamic) return null;
  const prefix = dynamic.prefix;
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
  anchorText?: string,
): string | null {
  if (!testId || isBroadContainerTestId(testId)) return null;

  const propPatched = patchPropKeyedTextColor(content, testId, color, anchorText);
  if (propPatched) return propPatched;

  if (anchorText) {
    const scoped = patchTextColorInContainerByAnchor(content, testId, anchorText, color);
    if (scoped) return scoped;
  }

  const mapPatched = patchMapItemBackground(content, testId, "color", color);
  if (mapPatched) return mapPatched;

  const el = findOpeningTagAtTestId(content, testId);
  if (!el || !/<Text\b/.test(el.tag)) return null;

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

function patchTextReplaceAnywhere(
  content: string,
  oldText: string,
  newText: string,
): string | null {
  return patchTextReplaceInSlice(content, 0, content.length, oldText, newText);
}

function patchTextReplaceWithTestId(
  content: string,
  testId: string,
  oldText: string,
  newText: string,
): string | null {
  if (testId && !isBroadContainerTestId(testId)) {
    const propPatched = patchPropKeyedText(content, testId, oldText, newText);
    if (propPatched) return propPatched;

    const mapPatched = patchMapItemText(content, testId, oldText, newText);
    if (mapPatched) return mapPatched;

    const byId = patchTextElementByTestId(content, testId, newText, oldText);
    if (byId) return byId;

    const el = findOpeningTagAtTestId(content, testId);
    if (el) {
      const inScope = patchTextReplaceInScope(content, el, oldText, newText);
      if (inScope) return inScope;
    }
    return null;
  }

  return patchTextReplaceAnywhere(content, oldText, newText);
}

/**
 * Text inside `.map()` templates is shared across items — patch a per-item
 * ternary so only the tapped row changes (e.g. only Wednesday loses its hint).
 */
function patchMapItemText(
  content: string,
  testId: string,
  oldText: string,
  newText: string,
): string | null {
  const dynamic = splitDynamicTestId(testId);
  if (!dynamic) return null;
  const dayValue = dynamic.suffix;

  const templateEl = findTemplateTestIdElement(content, testId);
  if (!templateEl || !/<Text\b/.test(templateEl.tag)) return null;

  const bounds = readTextElementBounds(content, templateEl);
  if (!bounds) return null;

  const mapParam = findMapIteratorParamBefore(content, templateEl.start);
  if (!mapParam) return null;

  const { inner, closeIndex } = bounds;
  const trimmed = inner.trim();
  const oldCore = stripEmoji(oldText) || oldText;

  const paramRef = trimmed.match(new RegExp(`^\\{\\s*(${mapParam}(?:\\.\\w+)?)\\s*\\}$`));
  if (paramRef) {
    const ref = paramRef[1];
    if (oldCore === dayValue || oldText.trim() === dayValue) {
      const nextInner = `{${mapParam} === '${dayValue}' ? ${JSON.stringify(newText)} : ${ref}}`;
      return content.slice(0, templateEl.end) + nextInner + content.slice(closeIndex);
    }
    return null;
  }

  const matchesLiteral = (): boolean => {
    if (replaceJsxExpressionLiteral(trimmed, oldText, "__tap__") !== null) return true;
    if (!trimmed.includes("{")) {
      return (
        trimmed === oldText ||
        stripEmoji(trimmed) === oldCore ||
        trimmed.trim() === oldText.trim()
      );
    }
    return false;
  };
  if (!matchesLiteral()) return null;

  const defaultExpr = literalDefaultExpr(trimmed, oldText);
  const nextInner = `{${mapParam} === '${dayValue}' ? ${JSON.stringify(newText)} : ${defaultExpr}}`;
  return content.slice(0, templateEl.end) + nextInner + content.slice(closeIndex);
}

function literalDefaultExpr(trimmed: string, fallback: string): string {
  const single = trimmed.match(/^\{([\s\S]*)\}$/);
  if (single) {
    const expr = single[1].trim();
    const quoted = expr.match(/^["']((?:\\.|[^"\\])*)["']$/);
    if (quoted) {
      return JSON.stringify(quoted[1].replace(/\\"/g, '"').replace(/\\'/g, "'"));
    }
  }
  if (!trimmed.includes("{")) return JSON.stringify(trimmed);
  return JSON.stringify(fallback);
}

function formatJsxTextExpr(text: string): string {
  return `{${JSON.stringify(text)}}`;
}

function readTextElementBounds(
  content: string,
  tag: { start: number; end: number },
): { inner: string; closeIndex: number } | null {
  const opening = content.slice(tag.start, tag.end);
  if (opening.trimEnd().endsWith("/>")) return null;
  const tagName = opening.match(/^<(\w+)/)?.[1];
  if (!tagName) return null;
  const closeRe = new RegExp(`</${tagName}>`, "g");
  closeRe.lastIndex = tag.end;
  const close = closeRe.exec(content);
  if (!close) return null;
  return { inner: content.slice(tag.end, close.index), closeIndex: close.index };
}

/** Patch <Text testID="...">{"label"}</Text> and plain-text children. */
function patchTextElementByTestId(
  content: string,
  testId: string,
  newText: string,
  oldText?: string,
): string | null {
  const el =
    findOpeningTagAtTestId(content, testId) ?? findTemplateTestIdElement(content, testId);
  if (!el || !/<Text\b/.test(el.tag)) return null;

  const bounds = readTextElementBounds(content, el);
  if (!bounds) return null;

  const { inner, closeIndex } = bounds;
  const trimmed = inner.trim();
  const oldCore = oldText ? stripEmoji(oldText) || oldText : "";
  const matchesOld = (current: string) => {
    if (!oldText) return true;
    const core = stripEmoji(current) || current;
    return (
      current === oldText ||
      core === oldCore ||
      current.trim() === oldText.trim()
    );
  };

  if (!trimmed.includes("{")) {
    if (matchesOld(trimmed)) {
      return content.slice(0, el.end) + newText + content.slice(closeIndex);
    }
    return null;
  }

  const singleExpr = trimmed.match(/^\{([\s\S]*)\}$/);
  if (singleExpr) {
    const expr = singleExpr[1].trim();
    const quoted = expr.match(/^["']((?:\\.|[^"\\])*)["']$/);
    if (quoted) {
      const current = quoted[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
      if (matchesOld(current)) {
        const nextInner = formatJsxTextExpr(newText);
        return content.slice(0, el.end) + nextInner + content.slice(closeIndex);
      }
    }
    const tmpl = expr.match(/^`((?:\\.|[^`])*)`$/);
    if (tmpl) {
      const current = tmpl[1].replace(/\\`/g, "`");
      if (matchesOld(current)) {
        const nextInner = formatJsxTextExpr(newText);
        return content.slice(0, el.end) + nextInner + content.slice(closeIndex);
      }
    }
  }

  const innerPatched = patchTextReplaceInSlice(
    content,
    el.end,
    closeIndex,
    oldText ?? "",
    newText,
  );
  if (innerPatched) return innerPatched;

  return null;
}

function readStaticInnerText(
  content: string,
  tag: { start: number; end: number },
): string {
  const opening = content.slice(tag.start, tag.end);
  if (opening.trimEnd().endsWith("/>")) return "";
  const tagName = opening.match(/^<(\w+)/)?.[1];
  if (!tagName) return "";
  const closeRe = new RegExp(`</${tagName}>`, "g");
  closeRe.lastIndex = tag.end;
  const close = closeRe.exec(content);
  if (!close) return "";
  return content.slice(tag.end, close.index).trim();
}

function patchTextReplaceInScope(
  content: string,
  tag: { start: number; end: number },
  oldText: string,
  newText: string,
): string | null {
  const scopeEnd = Math.min(content.length, tag.start + 5000);
  return patchTextReplaceInSlice(content, tag.start, scopeEnd, oldText, newText);
}

function patchTextReplaceInSlice(
  content: string,
  scopeStart: number,
  scopeEnd: number,
  oldText: string,
  newText: string,
): string | null {
  const slice = content.slice(scopeStart, scopeEnd);

  if (!newText.trim() && (isEmojiOnlyRemoval(oldText, newText) || isLikelyIconGlyph(oldText))) {
    const iconRemoved = removeIconComponentsFromScope(slice);
    if (iconRemoved) {
      return content.slice(0, scopeStart) + iconRemoved + content.slice(scopeEnd);
    }
    const emojiOnly = removeEmojiFromScope(slice, oldText, newText);
    if (emojiOnly) {
      return content.slice(0, scopeStart) + emojiOnly + content.slice(scopeEnd);
    }
  }

  if (isEmojiOnlyRemoval(oldText, newText)) {
    const emojiOnly = removeEmojiFromScope(slice, oldText, newText);
    if (emojiOnly) {
      return content.slice(0, scopeStart) + emojiOnly + content.slice(scopeEnd);
    }
  }

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

  const jsxExpr = replaceJsxExpressionLiteral(slice, oldText, newText);
  if (jsxExpr) {
    return content.slice(0, scopeStart) + jsxExpr + content.slice(scopeEnd);
  }

  const emojiOnly = removeEmojiFromScope(slice, oldText, newText);
  if (emojiOnly) {
    return content.slice(0, scopeStart) + emojiOnly + content.slice(scopeEnd);
  }

  return null;
}

function replaceJsxExpressionLiteral(
  slice: string,
  oldText: string,
  newText: string,
): string | null {
  const needles = [oldText, stripEmoji(oldText)].filter(
    (v, i, arr) => Boolean(v) && arr.indexOf(v) === i,
  );
  for (const needle of needles) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`\\{\\s*["']${escaped}["']\\s*\\}`, "gu"),
      new RegExp(`\\{\\s*\`${escaped}\`\\s*\\}`, "gu"),
    ];
    for (const re of patterns) {
      if (!re.test(slice)) continue;
      let hit = false;
      const patched = slice.replace(re, () => {
        hit = true;
        return formatJsxTextExpr(newText);
      });
      if (hit) return patched;
    }
  }
  return null;
}

function isEmojiOnlyRemoval(oldText: string, newText: string): boolean {
  return stripEmoji(oldText) === newText.trim();
}

function isLikelyIconGlyph(text: string): boolean {
  const t = text.trim();
  if (!t || t === "icon") return true;
  if (t.length <= 2 && /[\p{Extended_Pictographic}\p{So}]/u.test(t)) return true;
  return false;
}

function patchRemoveIconInFile(
  content: string,
  testId: string,
  anchorText?: string,
): string | null {
  if (anchorText) {
    const anchorIdx = findAnchorIndex(content, anchorText);
    if (anchorIdx !== -1) {
      const container = findSmallestContainerBefore(content, anchorIdx);
      if (container) {
        const scopeEnd = Math.min(content.length, container.start + 6000);
        const slice = content.slice(container.start, scopeEnd);
        const removed = removeIconComponentsFromScope(slice);
        if (removed) {
          return content.slice(0, container.start) + removed + content.slice(scopeEnd);
        }
      }
    }
  }

  if (testId && !isBroadContainerTestId(testId)) {
    const el = findOpeningTagAtTestId(content, testId);
    if (el) {
      const container = isContainerTag(el.tag)
        ? el
        : findSmallestContainerBefore(content, el.end);
      const scopeStart = container?.start ?? el.start;
      const scopeEnd = Math.min(content.length, scopeStart + 6000);
      const slice = content.slice(scopeStart, scopeEnd);
      const removed = removeIconComponentsFromScope(slice);
      if (removed) {
        return content.slice(0, scopeStart) + removed + content.slice(scopeEnd);
      }
    }
  }

  const removed = removeIconComponentsFromScope(content);
  return removed;
}

function removeIconComponentsFromScope(slice: string): string | null {
  let hit = false;
  let out = slice;

  const iconSelfClosing =
    /<(?:Ionicons|MaterialIcons|MaterialCommunityIcons|FontAwesome5?|FontAwesome6|AntDesign|Feather|Entypo|SimpleLineIcons|Octicons|Zocial|Foundation|EvilIcons)\b[^>]*\/>/g;
  out = out.replace(iconSelfClosing, () => {
    hit = true;
    return "";
  });

  out = out.replace(
    /<Text[^>]*>\s*[\p{Extended_Pictographic}\p{So}\uFE0F]+\s*<\/Text>/gu,
    () => {
      hit = true;
      return "";
    },
  );

  out = out.replace(
    /<Text[^>]*>\s*\{\s*["'`][\p{Extended_Pictographic}\p{So}\uFE0F\s]*["'`]\s*\}\s*<\/Text>/gu,
    () => {
      hit = true;
      return "";
    },
  );

  out = out.replace(
    /\{\s*["'`][\p{Extended_Pictographic}\p{So}\uFE0F\s]*["'`]\s*\}/gu,
    () => {
      hit = true;
      return "";
    },
  );

  if (hit) {
    out = out.replace(/\n\s*\n/g, "\n");
  }

  return hit ? out : null;
}

/** Preview had emoji but source stores it separately or inline — user removed it. */
function removeEmojiFromScope(slice: string, oldText: string, newText: string): string | null {
  if (stripEmoji(oldText) !== newText.trim()) return null;

  let hit = false;
  let out = slice;

  // Drop standalone emoji JSX expressions: {"👋"}, {" 👋"}, <Text>👋</Text>
  out = out.replace(
    /\{\s*["'`][\p{Extended_Pictographic}\uFE0F\s]*["'`]\s*\}/gu,
    () => {
      hit = true;
      return "";
    },
  );

  out = out.replace(
    /<Text[^>]*>\s*[\p{Extended_Pictographic}\uFE0F]+\s*<\/Text>/gu,
    () => {
      hit = true;
      return "";
    },
  );

  // Emoji inline in JSX text nodes: >Hello! 👋<
  out = out.replace(
    />([^<]*)[\p{Extended_Pictographic}\uFE0F]+([^<]*)</gu,
    (_m, a: string, b: string) => {
      hit = true;
      return `>${a}${b}<`;
    },
  );

  // Emoji inside quoted literals: "Hello, Chef! 👋"
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

  // Template literals: `Hello, Chef! 👋`
  out = out.replace(/`[^`]*`/gu, (full) => {
    const inner = full.slice(1, -1);
    const trimmed = inner
      .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (trimmed !== inner) {
      hit = true;
      return `\`${trimmed}\``;
    }
    return full;
  });

  if (hit) {
    // Clean up double spaces / stray glue after removing emoji blocks
    out = out.replace(/>\s{2,}</g, "> <");
    out = out.replace(/(\S)\s{2,}(\S)/g, "$1 $2");
  }

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
  const templateEl = findTemplateTestIdElement(content, testId);
  if (templateEl) return templateEl;

  const dynamic = splitDynamicTestId(testId);
  if (dynamic) {
    const prefix = dynamic.prefix;
    const suffix = dynamic.suffix;
    const templateMarker = `testID={\`${prefix}-\${`;
    const tIdx = content.indexOf(templateMarker);
    if (tIdx !== -1) {
      const tag = walkBackToOpeningTag(content, tIdx);
      if (tag?.tag.includes("testID")) return tag;
    }
    // Static per-item IDs (rare): week-day-Wed with literal Wed in the subtree
    let from = 0;
    while (from < content.length) {
      const litIdx = content.indexOf(`testID="${testId}"`, from);
      if (litIdx === -1) break;
      from = litIdx + 1;
      const tag = walkBackToOpeningTag(content, litIdx);
      if (tag) return tag;
    }
    const scopeMarker = `\`${prefix}-\${`;
    from = 0;
    while (from < content.length) {
      const mIdx = content.indexOf(scopeMarker, from);
      if (mIdx === -1) break;
      from = mIdx + scopeMarker.length;
      const tag = walkBackToOpeningTag(content, mIdx);
      if (!tag) continue;
      const scopeEnd = Math.min(content.length, tag.end + 1200);
      const scope = content.slice(tag.end, scopeEnd);
      if (
        scope.includes(`>${suffix}<`) ||
        scope.includes(`"${suffix}"`) ||
        scope.includes(`'${suffix}'`)
      ) {
        return tag;
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
    } else if (c.type === "removeIcon") {
      parts.push("the icon is removed");
    }
  }
  if (parts.length === 0) return "Done - your change is in!";
  if (parts.length === 1) return `Done - ${parts[0]}.`;
  return `Done - ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

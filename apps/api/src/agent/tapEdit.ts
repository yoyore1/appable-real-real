import { emit } from "../events.js";
import { listProjectFiles, readProjectFile, writeProjectFile } from "../orchestrator.js";
import {
  LIST_ITEM_FIELD_SUFFIX,
  deriveRowTestIdFromLabel,
  isListItemFieldTestId,
  isSharedMapTemplateElement,
  listItemStyleTestIdCandidates,
  parseListItemId,
  parseListItemTestContext,
  resolveListItemTestIdFromAnchor,
} from "./tapEditDiscovery.js";
type StyleProp = "color" | "backgroundColor" | "fontWeight" | "fontFamily";

export interface TapEditChange {
  type: "text" | "color" | "background" | "fontWeight" | "fontFamily" | "removeIcon";
  value: string;
  /** Original text for scoped replacements inside a container. */
  oldValue?: string;
  /** Label inside the card whose background should change (e.g. "Tue"). */
  anchorText?: string;
  /** Whole screen / page background (ScrollView root style). */
  screen?: boolean;
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
    const bgByTestId = part.match(
      /^set the background color of the element with testID "([^"]+)" to (#[0-9A-Fa-f]{3,8})$/u,
    );
    if (bgByTestId) {
      changes.push({ type: "background", value: bgByTestId[2] });
      continue;
    }
    const bg = part.match(/^set the background color to (#[0-9A-Fa-f]{3,8})$/);
    if (bg) {
      changes.push({ type: "background", value: bg[1] });
      continue;
    }
    const screenBg = part.match(/^set the screen background color to (#[0-9A-Fa-f]{3,8})$/);
    if (screenBg) {
      changes.push({ type: "background", value: screenBg[1], screen: true });
      continue;
    }
    const fwScoped = part.match(/^set the font weight of "(.+)" to (bold|normal)$/u);
    if (fwScoped) {
      changes.push({
        type: "fontWeight",
        value: fwScoped[2] === "bold" ? "700" : "400",
        anchorText: fwScoped[1],
      });
      continue;
    }
    const fw = part.match(/^set the font weight to (bold|normal)$/u);
    if (fw) {
      changes.push({
        type: "fontWeight",
        value: fw[1] === "bold" ? "700" : "400",
      });
      continue;
    }
    const ffScoped = part.match(/^set the font family of "(.+)" to (.+)$/u);
    if (ffScoped) {
      changes.push({
        type: "fontFamily",
        value: normalizeTapFontFamily(ffScoped[2]),
        anchorText: ffScoped[1],
      });
      continue;
    }
    const ff = part.match(/^set the font family to (.+)$/u);
    if (ff) {
      changes.push({
        type: "fontFamily",
        value: normalizeTapFontFamily(ff[1]),
      });
    }
  }

  if (changes.length === 0) return null;
  return { testId, changes };
}

/**
 * Apply tap-to-edit color/background changes directly in source files.
 * Preview-only DOM tweaks from the bridge are not persisted — this is.
 */
/** Build UI tap-to-edit message for a text replace probe or save. */
export function buildTapEditReplaceMessage(
  testId: string,
  oldText: string,
  newText: string,
): string {
  const escapedOld = oldText.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedNew = newText.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[Tap edit] In the app, find the element with testID "${testId}" and replace the text "${escapedOld}" with "${escapedNew}". Change only what was tapped.`;
}

export function buildTapEditColorMessage(testId: string, color: string): string {
  return `[Tap edit] In the app, find the element with testID "${testId}" and set the text color to ${color}. Change only what was tapped.`;
}

export function buildTapEditBackgroundMessage(testId: string, color: string): string {
  return `[Tap edit] In the app, find the element with testID "${testId}" and set the background color to ${color}. Change only what was tapped.`;
}

function resolveEffectiveTestId(
  parsed: TapEditRequest,
  sources: Map<string, string>,
): string {
  let testId =
    parsed.testId && !isBroadContainerTestId(parsed.testId) ? parsed.testId : "";

  const anchor = parsed.changes.find((c) => c.anchorText)?.anchorText;
  if (!testId && anchor) {
    testId = resolveListItemTestIdFromAnchor(sources, anchor) ?? "";
  }

  return testId;
}

type TapEditPatchAttempt =
  | { ok: true; summary: string; file: string; updated: string }
  | { ok: false };

export function attemptTapEditPatch(
  parsed: TapEditRequest,
  sources: Map<string, string>,
): TapEditPatchAttempt {
  const hasWork = parsed.changes.some(
    (c) =>
      c.type === "color" ||
      c.type === "background" ||
      c.type === "fontWeight" ||
      c.type === "fontFamily" ||
      c.type === "removeIcon" ||
      c.type === "text",
  );
  if (!hasWork) return { ok: false };

  const onlyBackground = parsed.changes.every((c) => c.type === "background");
  const hasAnchor = parsed.changes.some((c) => c.anchorText);
  const hasTextReplace = parsed.changes.some((c) => c.type === "text" && c.oldValue);
  const hasTextSet = parsed.changes.some((c) => c.type === "text" && !c.oldValue);
  const hasIconRemoval = parsed.changes.some((c) => c.type === "removeIcon");
  const effectiveTestId = resolveEffectiveTestId(parsed, sources);

  if (!effectiveTestId && !hasAnchor && !hasTextReplace && !hasIconRemoval && !onlyBackground) {
    return { ok: false };
  }

  const screenBgChange = parsed.changes.find((c) => c.type === "background" && c.screen);
  if (screenBgChange) {
    return attemptPatchScreenBackgroundInSources(sources, screenBgChange.value, parsed.changes);
  }

  let candidates = findCandidateFilesInSources(
    sources,
    effectiveTestId || parsed.testId,
    parsed.changes,
  );
  if (candidates.length === 0 && (hasTextReplace || hasTextSet || onlyBackground)) {
    candidates = [...sources.keys()].filter(isEditableSourceFile);
  }

  const tried = new Set<string>();
  for (const file of candidates) {
    tried.add(file);
    const content = sources.get(file);
    if (content === undefined) continue;
    const updated = patchTapEditInFile(content, effectiveTestId, parsed.changes);
    if (updated && updated !== content && looksLikeValidSource(updated)) {
      return { ok: true, summary: tapEditSummary(parsed.changes), file, updated };
    }
  }

  if (hasTextReplace && !effectiveTestId) {
    for (const file of sources.keys()) {
      if (!isEditableSourceFile(file) || tried.has(file)) continue;
      const content = sources.get(file);
      if (content === undefined) continue;
      const updated = patchTapEditInFile(content, "", parsed.changes);
      if (updated && updated !== content && looksLikeValidSource(updated)) {
        return { ok: true, summary: tapEditSummary(parsed.changes), file, updated };
      }
    }
  }

  // Shared components (AppButton, SettingsRow…) render the tapped element via
  // testID passthrough — the runtime id never appears in the component file.
  const passthroughId = effectiveTestId || parsed.testId;
  if (passthroughId) {
    const pt = patchComponentPassthroughInSources(sources, passthroughId, parsed.changes);
    if (pt && looksLikeValidSource(pt.updated)) {
      return { ok: true, summary: tapEditSummary(parsed.changes), file: pt.file, updated: pt.updated };
    }
  }

  return { ok: false };
}

/**
 * Patch tapped elements rendered by shared components via testID passthrough.
 *
 * Runtime id "home-add-habit" → `<Pressable testID={testID}>` in AppButton.tsx,
 * runtime id "home-add-habit-label" → `<Text testID={`${testID}-label`}>` there.
 * The component file is located by finding the literal instantiation
 * (`<AppButton testID="home-add-habit"`) and matching its exported tag name.
 */
function patchComponentPassthroughInSources(
  sources: Map<string, string>,
  testId: string,
  changes: TapEditChange[],
): { file: string; updated: string } | null {
  const instance = findComponentInstantiation(sources, testId);
  if (!instance) return null;

  for (const [file, content] of sources) {
    if (!isEditableSourceFile(file)) continue;
    if (!componentFileExports(content, instance.componentName)) continue;

    // Restrict passthrough scanning to the branch of the component that
    // matches the instantiation. Without this, tapping `<AppButton testID="…"
    // variant="primary" />` would paint all three branches in AppButton.tsx
    // (primary, secondary, danger) because they all share `testID={testID}`.
    const branchSelection = instance.variant
      ? selectComponentBranch(content, instance.variant)
      : selectComponentBranch(content, null);
    const branch = branchSelection ?? content;
    const branchStart = branchSelection ? content.indexOf(branch) : -1;

    let updated = content;
    let touched = false;

    for (const change of changes) {
      if (change.type === "background") {
        const next = patchPassthroughElements(branch, /testID=\{testID\}/g, (tag) =>
          isContainerTag(tag) ? patchStyleOnTag(tag, "backgroundColor", change.value) : null,
        );
        if (next && branchStart !== -1) {
          // Splice the patched branch back into the full file.
          updated =
            content.slice(0, branchStart) + next + content.slice(branchStart + branch.length);
          touched = true;
        }
        continue;
      }

      if (
        (change.type === "color" || change.type === "fontWeight" || change.type === "fontFamily") &&
        instance.suffix
      ) {
        const suffixRe = new RegExp(
          `testID=\\{\\\`\\$\\{testID\\}-${instance.suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\\`\\}`,
          "g",
        );
        const next = patchPassthroughElements(branch, suffixRe, (tag) =>
          /<Text\b/.test(tag) ? patchStyleOnTag(tag, change.type as StyleProp, change.value) : null,
        );
        if (next && branchStart !== -1) {
          updated =
            content.slice(0, branchStart) + next + content.slice(branchStart + branch.length);
          touched = true;
        }
        continue;
      }
    }

    if (touched && updated !== content) return { file, updated };
  }
  return null;
}

/**
 * Locate the literal `<SomeComponent testID="…">` instantiation that produces
 * this runtime testID, trying the full id first, then progressively shorter
 * bases with the remainder as a passthrough suffix ("home-add-habit-label" →
 * base "home-add-habit" + suffix "label").
 */
export function findComponentInstantiation(
  sources: Map<string, string>,
  testId: string,
): { componentName: string; base: string; suffix: string | null; variant?: string } | null {
  const candidates: { base: string; suffix: string | null }[] = [{ base: testId, suffix: null }];
  const parts = testId.split("-");
  for (let i = parts.length - 1; i >= 1; i--) {
    const base = parts.slice(0, i).join("-");
    const suffix = parts.slice(i).join("-");
    if (base && suffix) candidates.push({ base, suffix });
  }

  for (const { base, suffix } of candidates) {
    for (const content of sources.values()) {
      // Locate the testID literal anywhere in the source; the JSX tag may
      // span multiple lines and contain nested elements as prop values
      // (e.g. `icon={<Ionicons name="…" />}`), so we walk the tag from
      // its opening `<Name` to the matching `>` / `/>` using the same
      // brace/quote-aware scanner as `scanOpeningTagEnd`.
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const needle = `testID="${escaped}"`;
      let searchFrom = 0;
      while (searchFrom < content.length) {
        const idx = content.indexOf(needle, searchFrom);
        if (idx === -1) break;
        searchFrom = idx + needle.length;
        // Walk back to find the opening `<` of this tag.
        const openIdx = walkBackToOpenAngle(content, idx);
        if (openIdx === -1) continue;
        const nameMatch = /^<([A-Z]\w*)/.exec(content.slice(openIdx));
        const name = nameMatch?.[1];
        if (!name || NATIVE_TAGS.has(name)) continue;
        // Use the existing scanOpeningTagEnd to capture the full tag, then
        // look for `variant` inside it.
        const tagEnd = scanOpeningTagEnd(content, openIdx);
        const fullTag = content.slice(openIdx, tagEnd);
        const variantMatch = fullTag.match(/\bvariant="([^"]+)"/);
        return {
          componentName: name,
          base,
          suffix,
          variant: variantMatch?.[1],
        };
      }
    }
  }
  return null;
}

/** Like walkBackToOpeningTag but always returns the index of the `<` itself. */
function walkBackToOpenAngle(content: string, idx: number): number {
  for (let i = idx; i >= 0; i--) {
    if (content[i] === "<") return i;
    if (content[i] === ">" || content[i] === "\n") {
      // `>` closes a previous tag; newlines (rare inside one tag) abort
      // to avoid crossing tag boundaries.
      if (content[i] === ">") return -1;
    }
  }
  return -1;
}

function componentFileExports(content: string, componentName: string): boolean {
  return new RegExp(`export (?:function|const) ${componentName}\\b`).test(content);
}

/**
 * Pick the JSX branch of a variant-aware component that the instantiation
 * actually used. For `variant="primary"` (the default) it returns the trailing
 * return-statement block; for `"secondary"` or `"danger"` it returns the
 * matching `if (variant === "X") { … }` block. Brace-matched, so nested
 * components and ternaries don't trip it up.
 */
export function selectComponentBranch(content: string, variant: string | null): string | null {
  if (!variant || variant === "primary") {
    // Default branch: the LAST `return (` of the component body. The opener
    // `(` is part of the regex match, so balance from the position right
    // after `return`, and require the close to be followed by `;` (otherwise
    // we hit an inner paren like `({pressed})` in a JSX expression).
    const re = /return\s*\(/g;
    let m: RegExpExecArray | null;
    let best: { start: number; end: number } | null = null;
    while ((m = re.exec(content)) !== null) {
      const parenOpen = m.index + m[0].length - 1; // the `(` itself
      const end = matchParenBlock(content, parenOpen);
      if (end !== -1 && (best === null || m.index > best.start)) {
        best = { start: m.index, end };
      }
    }
    return best ? content.slice(best.start, best.end) : content;
  }
  const re = new RegExp(`if\\s*\\(\\s*variant\\s*===\\s*["']${variant}["']\\s*\\)\\s*\\{`, "g");
  const m = re.exec(content);
  if (!m) return null;
  const blockStart = m.index + m[0].length;
  const blockEnd = matchBracedBlock(content, blockStart);
  if (blockEnd === -1) return null;
  return content.slice(m.index, blockEnd);
}

function matchBracedBlock(content: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < content.length) {
    const c = content[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Match a `return (…)` block. `start` must point AT the opening `(` so the
 * first depth=0 close is the matching one. JSX-expression parens (like
 * `({pressed})` in `style={({pressed}) => […]}`) are skipped because their
 * closing `)` is followed by `=>` (not `;`).
 */
function matchParenBlock(content: string, start: number): number {
  if (content[start] !== "(") return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === quote && content[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < content.length && /\s/.test(content[j])) j++;
        if (content[j] === ";") return i + 1;
      }
    }
  }
  return -1;
}

/** Apply a tag patcher to every element whose opening tag matches the testID pattern. */
function patchPassthroughElements(
  content: string,
  testIdPattern: RegExp,
  patchTag: (tag: string) => string | null,
): string | null {
  const matches: { start: number; end: number; tag: string }[] = [];
  let m: RegExpExecArray | null;
  testIdPattern.lastIndex = 0;
  while ((m = testIdPattern.exec(content)) !== null) {
    const el = walkBackToOpeningTag(content, m.index);
    if (el) matches.push(el);
  }
  if (matches.length === 0) return null;

  let updated = content;
  let touched = false;
  // Back to front so earlier offsets stay valid.
  for (const el of matches.reverse()) {
    const patched = patchTag(el.tag);
    if (!patched) continue;
    updated = updated.slice(0, el.start) + patched + updated.slice(el.end);
    touched = true;
  }
  return touched ? updated : null;
}

/** Dry-run: would this tap-to-edit message apply? Uses an in-memory file map. */
export function probeTapEditRequest(
  request: string,
  sources: Map<string, string>,
): { ok: true; file: string } | { ok: false } {
  const parsed = parseTapEditRequest(request);
  if (!parsed) return { ok: false };

  // New architecture: any request targeting a registered testID is applied
  // as a runtime override, no source patching required.
  if (parsed.testId && hasEditableComponent(sources, parsed.testId)) {
    return { ok: true, file: "runtime" };
  }

  const result = attemptTapEditPatch(parsed, sources);
  return result.ok ? { ok: true, file: result.file } : { ok: false };
}

function hasEditableComponent(sources: Map<string, string>, testId: string): boolean {
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Static testID: testID="..." or testID={'...'} or testID={"..."}
  const staticPattern = new RegExp(`<Editable(?:Text|Icon|Background)\\b[^>]*testID=["'\\{]?${escaped}["'\\}]?`, "g");
  // Template literal testID: testID={\`...\`}
  const templatePattern = new RegExp(`<Editable(?:Text|Icon|Background)\\b[^>]*testID=\\{\\\`[^\\\`]*\\$\\{[^}]+\\}[^\\\`]*\\\`}`, "g");
  for (const content of sources.values()) {
    if (staticPattern.test(content)) return true;
    if (testId.includes("-")) {
      // For template IDs like home-recipe-{id}-name, check if the pattern exists
      const idPart = testId.replace(/.*-([a-zA-Z]+-[a-zA-Z0-9]+-)?/, ""); // heuristic
      const loosePattern = new RegExp(`<Editable(?:Text|Icon|Background)\\b[^>]*testID=\\{\\\`[^\\\`]*${escaped.split("-").slice(0, -1).join("-")}[^\\\`]*\\\`}`, "g");
      if (loosePattern.test(content)) return true;
    }
  }
  return false;
}

export async function loadTapEditSourceCache(projectId: string): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  for (const file of await allEditableSourceFiles(projectId)) {
    cache.set(file, await readProjectFile(projectId, file));
  }
  return cache;
}

export async function tryTapEditPatch(
  projectId: string,
  request: string,
): Promise<{ ok: true; summary: string; file: string } | { ok: false }> {
  const parsed = parseTapEditRequest(request);
  if (!parsed) return { ok: false };

  // New architecture: tap-to-edit is a runtime override, not a source patch.
  // If the request names a specific element, emit the override instruction
  // directly to the preview frame. The bridge looks up the registered
  // EditableText/Icon/Background and applies it in ~16ms.
  const runtimePatch = buildRuntimeTapEditPatch(parsed);
  if (runtimePatch) {
    emit(projectId, {
      type: "tap_edit.apply",
      testID: runtimePatch.testID,
      patch: runtimePatch.patch,
    });
    emit(projectId, {
      type: "build.event",
      level: "info",
      source: "system",
      text: `tap-edit: applied runtime override for ${runtimePatch.testID}`,
      timestamp: new Date().toISOString(),
    });
    return { ok: true, summary: tapEditSummary(parsed.changes), file: "runtime" };
  }

  // Legacy fallback for screen backgrounds and unscoped edits.
  const sources = await loadTapEditSourceCache(projectId);
  const screenBgChange = parsed.changes.find((c) => c.type === "background" && c.screen);
  if (screenBgChange) {
    const screenResult = await tryPatchScreenBackground(
      projectId,
      screenBgChange.value,
      parsed.changes,
    );
    if (screenResult) return screenResult;
    emit(projectId, {
      type: "build.event",
      level: "warn",
      source: "system",
      text: `tap-edit: could not patch screen background for ${request.slice(0, 100)}`,
      timestamp: new Date().toISOString(),
    });
    return { ok: false };
  }

  const result = attemptTapEditPatch(parsed, sources);
  if (result.ok) {
    await writeProjectFile(projectId, result.file, result.updated);
    emit(projectId, { type: "file.op", op: "write", path: result.file });
    return { ok: true, summary: result.summary, file: result.file };
  }

  emit(projectId, {
    type: "build.event",
    level: "warn",
    source: "system",
    text: `tap-edit: could not patch source for ${request.slice(0, 100)}`,
    timestamp: new Date().toISOString(),
  });
  return { ok: false };
}

function buildRuntimeTapEditPatch(
  parsed: TapEditRequest,
): { testID: string; patch: Record<string, string | number> } | null {
  const testId = parsed.testId;
  if (!testId) return null;

  const patch: Record<string, string | number> = {};
  for (const change of parsed.changes) {
    if (change.type === "text") patch.text = change.value;
    if (change.type === "color") patch.color = change.value;
    if (change.type === "background") patch.backgroundColor = change.value;
    if (change.type === "fontWeight") patch.fontWeight = change.value;
    if (change.type === "fontFamily") patch.fontFamily = change.value;
  }

  if (Object.keys(patch).length === 0) return null;
  return { testID: testId, patch };
}

function attemptPatchScreenBackgroundInSources(
  sources: Map<string, string>,
  color: string,
  changes: TapEditChange[],
): TapEditPatchAttempt {
  const priority = ["src/theme/tokens.ts", "App.tsx"];
  for (const file of priority) {
    const content = sources.get(file);
    if (content === undefined) continue;
    const updated = file.endsWith("tokens.ts")
      ? patchThemeBackgroundToken(content, color)
      : patchAppShellBackground(content, color);
    if (updated && updated !== content && looksLikeValidSource(updated)) {
      return { ok: true, summary: tapEditSummary(changes), file, updated };
    }
  }

  for (const file of sources.keys()) {
    if (!isEditableSourceFile(file)) continue;
    const content = sources.get(file);
    if (content === undefined) continue;
    const updated = patchMainScrollBackground(content, color);
    if (updated && updated !== content && looksLikeValidSource(updated)) {
      return { ok: true, summary: tapEditSummary(changes), file, updated };
    }
  }
  return { ok: false };
}

function findCandidateFilesInSources(
  sources: Map<string, string>,
  testId: string | null,
  changes: TapEditChange[],
): string[] {
  const hits = new Set<string>();

  const specificTestId =
    testId && !isBroadContainerTestId(testId) ? testId : null;
  if (specificTestId) {
    for (const f of findFilesWithTestIdInSources(sources, specificTestId)) hits.add(f);
    const listCtx = parseListItemTestContext(specificTestId);
    if (listCtx) {
      for (const f of findFilesWithTestIdTemplatePrefixInSources(sources, listCtx.templatePrefix)) {
        hits.add(f);
      }
    }
    const dynamic = splitDynamicTestId(specificTestId);
    if (dynamic) {
      for (const f of findFilesWithTestIdTemplatePrefixInSources(sources, dynamic.prefix)) {
        hits.add(f);
      }
    }
  }

  const anchor = changes.find((c) => c.anchorText)?.anchorText;
  if (anchor) {
    for (const f of findFilesContainingTextInSources(sources, anchor)) hits.add(f);
  }

  for (const change of changes) {
    if (change.type === "text" && change.oldValue) {
      for (const f of findFilesContainingTextInSources(sources, change.oldValue)) {
        hits.add(f);
      }
    }
  }

  if (testId && isBroadContainerTestId(testId)) {
    for (const f of findFilesWithTestIdInSources(sources, testId)) hits.add(f);
  }

  return [...hits];
}

function findFilesWithTestIdInSources(
  sources: Map<string, string>,
  testId: string,
): string[] {
  const hits: string[] = [];
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dynamicRe = new RegExp(`testID=\\{[^}]*${escaped}`);
  const needles = [
    `testID="${testId}"`,
    `testID='${testId}'`,
    `testID={\`${testId}\`}`,
    `testID={"${testId}"}`,
    `testID={'${testId}'}`,
  ];
  for (const [file, content] of sources) {
    if (!/\.(tsx|jsx)$/.test(file)) continue;
    if (needles.some((n) => content.includes(n)) || dynamicRe.test(content)) {
      hits.push(file);
    }
  }
  return hits;
}

function findFilesWithTestIdTemplatePrefixInSources(
  sources: Map<string, string>,
  prefix: string,
): string[] {
  const marker = `testID={\`${prefix}-\${`;
  const hits: string[] = [];
  for (const [file, content] of sources) {
    if (!isEditableSourceFile(file)) continue;
    if (content.includes(marker)) hits.push(file);
  }
  return hits;
}

function findFilesContainingTextInSources(
  sources: Map<string, string>,
  text: string,
): string[] {
  const needles = [text, stripEmoji(text)].filter(
    (v, i, arr) => Boolean(v) && arr.indexOf(v) === i,
  );
  const hits: string[] = [];
  for (const [file, content] of sources) {
    if (!isEditableSourceFile(file)) continue;
    if (needles.some((n) => content.includes(n))) hits.push(file);
  }
  return hits;
}

/** Page background lives in theme tokens — not tab bar or random ScrollViews. */
async function tryPatchScreenBackground(
  projectId: string,
  color: string,
  changes: TapEditChange[],
): Promise<{ ok: true; summary: string; file: string } | null> {
  const priority = ["src/theme/tokens.ts", "App.tsx"];
  for (const file of priority) {
    const content = await readProjectFile(projectId, file).catch(() => null);
    if (content === null) continue;
    const updated = file.endsWith("tokens.ts")
      ? patchThemeBackgroundToken(content, color)
      : patchAppShellBackground(content, color);
    if (updated && updated !== content && looksLikeValidSource(updated)) {
      await writeProjectFile(projectId, file, updated);
      emit(projectId, { type: "file.op", op: "write", path: file });
      return { ok: true, summary: tapEditSummary(changes), file };
    }
  }

  for (const file of await allEditableSourceFiles(projectId)) {
    const content = await readProjectFile(projectId, file);
    const updated = patchMainScrollBackground(content, color);
    if (updated && updated !== content && looksLikeValidSource(updated)) {
      await writeProjectFile(projectId, file, updated);
      emit(projectId, { type: "file.op", op: "write", path: file });
      return { ok: true, summary: tapEditSummary(changes), file };
    }
  }
  return null;
}

/** Reject patches that would obviously break TSX before we write them. */
function looksLikeValidSource(src: string): boolean {
  // The legacy quote-count heuristic false-positives on apostrophes inside
  // string literals ("don't"), escaped quotes, and template strings. The
  // real test is whether the TypeScript parser accepts the file.
  return sourceHasNoSyntaxErrors(src);
}

let _ts: typeof import("typescript") | null = null;
function sourceHasNoSyntaxErrors(src: string): boolean {
  try {
    if (!_ts) {
      // Lazy ESM-aware load: prefer the modern namespace import, fall back to
      // CJS require, both so the API works under tsx and compiled builds.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const req = eval("require") as NodeRequire;
      _ts = req("typescript") as typeof import("typescript");
    }
    const sf = _ts.createSourceFile(
      "x.tsx",
      src,
      _ts.ScriptTarget.Latest,
      true,
      _ts.ScriptKind.TSX,
    );
    const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
    return !Array.isArray(diagnostics) || diagnostics.length === 0;
  } catch {
    return true; // never block on a TS loader failure
  }
}

/** Apply a tap-edit message to source text (for tests and debugging). */
export function applyTapEditToSource(content: string, request: string): string | null {
  const parsed = parseTapEditRequest(request);
  if (!parsed) return null;
  const testId =
    parsed.testId && !isBroadContainerTestId(parsed.testId) ? parsed.testId : "";
  return patchTapEditInFile(content, testId, parsed.changes);
}

function isEditableSourceFile(file: string): boolean {
  const norm = file.replace(/\\/g, "/");
  if (norm === "app/_layout.tsx" || norm === "app/(tabs)/_layout.tsx") return false;
  if (norm === "app/(stack)/_layout.tsx") return false;
  if (/^app\/\(tabs\)\/.+\.(tsx|jsx)$/.test(norm)) return true;
  if (/^app\/\(stack\)\/.+\.(tsx|jsx)$/.test(norm)) return true;
  if (norm === "App.tsx") return true;
  return /^src\/.*\.(tsx|jsx|ts)$/.test(norm) && !norm.endsWith(".d.ts");
}

async function allEditableSourceFiles(projectId: string): Promise<string[]> {
  const files = await listProjectFiles(projectId);
  return files.filter(isEditableSourceFile);
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
    const listCtx = parseListItemTestContext(specificTestId);
    if (listCtx) {
      for (const f of await findFilesWithTestIdTemplatePrefix(projectId, listCtx.templatePrefix)) {
        hits.add(f);
      }
    }
    const dynamic = splitDynamicTestId(specificTestId);
    if (dynamic) {
      for (const f of await findFilesWithTestIdTemplatePrefix(projectId, dynamic.prefix)) {
        hits.add(f);
      }
    }
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

async function findFilesWithTestIdTemplatePrefix(
  projectId: string,
  prefix: string,
): Promise<string[]> {
  const marker = `testID={\`${prefix}-\${`;
  const files = await listProjectFiles(projectId);
  const hits: string[] = [];
  for (const file of files) {
    if (!isEditableSourceFile(file)) continue;
    const content = await readProjectFile(projectId, file);
    if (content.includes(marker)) hits.push(file);
  }
  return hits;
}

async function findFilesContainingText(
  projectId: string,
  text: string,
): Promise<string[]> {
  const needles = [text, stripEmoji(text)].filter(
    (v, i, arr) => Boolean(v) && arr.indexOf(v) === i,
  );
  const files = await listProjectFiles(projectId);
  const hits: string[] = [];
  for (const file of files) {
    if (!isEditableSourceFile(file)) continue;
    const content = await readProjectFile(projectId, file);
    if (needles.some((n) => content.includes(n))) hits.push(file);
  }
  return hits;
}

/** testID prefixes like recipe-title-2 / tab-home → patch data arrays, not JSX literals. */
const DATA_FIELD_BY_TEST_ID_PREFIX: Record<string, string> = {
  "recipe-title": "title",
  tab: "label",
};

/** `{prefix}-{id}-{field}` rows in data files — discovered dynamically via tapEditDiscovery. */

/** Find JSX tagged with `{prefix}-${item.id}-name` for runtime `{prefix}-h1-name`. */
function findListItemTemplateElement(
  content: string,
  testId: string,
): { start: number; end: number; tag: string } | null {
  const ctx = parseListItemTestContext(testId);
  if (!ctx) return null;

  const marker = `\`${ctx.templatePrefix}-\${`;
  let from = 0;
  while (from < content.length) {
    const idx = content.indexOf(marker, from);
    if (idx === -1) break;
    from = idx + marker.length;
    const snippet = content.slice(idx, idx + 160);
    if (!snippet.includes(`-${ctx.fieldSuffix}`)) continue;
    const tag = walkBackToOpeningTag(content, idx);
    if (tag?.tag.includes("testID")) return tag;
  }
  return null;
}

function detectIdPropertyFromTemplate(tag: string): string {
  const m = tag.match(/\$\{(\w+)\.(\w+)\}/);
  return m?.[2] ?? "id";
}

function stripListItemConditionalStyle(
  styleExpr: string,
  prop: StyleProp,
  mapParam: string,
  itemId: string,
  idProp: string,
): string {
  const escId = itemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Outer braces optional: handles both the old (broken) braced form and the new bare form.
  const re = new RegExp(
    `,\\s*\\{?\\s*${mapParam}\\.${idProp}\\s*===\\s*['"]${escId}['"]\\s*&&\\s*\\{\\s*${prop}\\s*:[^}]+\\}\\s*\\}?`,
    "g",
  );
  return styleExpr.replace(re, "");
}

function appendListItemConditionalStyle(
  tag: string,
  conditional: string,
  prop: StyleProp,
  mapParam: string,
  itemId: string,
  idProp: string,
): string | null {
  const styleRange = findStyleAttribute(tag);
  if (!styleRange) {
    const insertAt = tag.lastIndexOf(tag.trimEnd().endsWith("/>") ? "/>" : ">");
    if (insertAt === -1) return null;
    return `${tag.slice(0, insertAt)} style={[${conditional}]}${tag.slice(insertAt)}`;
  }

  const inner = tag.slice(styleRange.innerStart, styleRange.innerEnd).trim();
  const cleaned = stripListItemConditionalStyle(inner, prop, mapParam, itemId, idProp);
  let replacement: string;
  if (cleaned.startsWith("[")) {
    const body = cleaned.replace(/^\[|\]$/g, "").trim();
    replacement = body ? `[${body}, ${conditional}]` : `[${conditional}]`;
  } else if (cleaned.startsWith("{")) {
    replacement = `[${cleaned}, ${conditional}]`;
  } else {
    const arrowPatched = appendToArrowStyle(cleaned, conditional);
    if (!arrowPatched && /=>/.test(cleaned)) return null;
    replacement = arrowPatched ?? `[${cleaned}, ${conditional}]`;
  }

  return (
    tag.slice(0, styleRange.innerStart) +
    replacement +
    tag.slice(styleRange.innerEnd)
  );
}

/**
 * Items rendered via `.map()` with `${item.id}` testIDs — patch a per-item conditional
 * style (e.g. only h1's name turns red).
 */
function patchListItemMapStyle(
  content: string,
  testId: string,
  prop: StyleProp,
  value: string,
): string | null {
  const ctx = parseListItemTestContext(testId);
  if (!ctx) return null;

  let templateEl = findListItemTemplateElement(content, testId);
  if (!templateEl && prop === "backgroundColor" && isListItemFieldTestId(testId)) {
    const rowId = deriveRowTestIdFromLabel(testId);
    if (rowId) templateEl = findListItemTemplateElement(content, rowId);
  }
  if (!templateEl) return null;

  const mapParam = findMapIteratorParamBefore(content, templateEl.start);
  if (!mapParam) return null;

  const idProp = detectIdPropertyFromTemplate(templateEl.tag);
  const textProp = prop === "color" || prop === "fontWeight" || prop === "fontFamily";
  const target =
    textProp && /<Text\b/.test(templateEl.tag)
      ? templateEl
      : isContainerTag(templateEl.tag)
        ? templateEl
        : findSmallestContainerBefore(content, templateEl.end);
  if (!target) return null;

  // No outer braces: inside a style array `{ cond && {...} }` is a syntax error.
  const conditional = `${mapParam}.${idProp} === '${ctx.itemId}' && { ${prop}: '${value}' }`;
  const patched = appendListItemConditionalStyle(
    target.tag,
    conditional,
    prop,
    mapParam,
    ctx.itemId,
    idProp,
  );
  if (!patched) return null;
  return replaceTagAt(content, target, patched);
}

function patchListItemDataField(
  content: string,
  testId: string,
  oldText: string,
  newText: string,
): string | null {
  for (const [fieldSuffix, fieldName] of Object.entries(LIST_ITEM_FIELD_SUFFIX)) {
    const id = parseListItemId(testId, fieldSuffix);
    if (!id) continue;
    const patched = patchObjectFieldById(content, id, fieldName, oldText, newText);
    if (patched) return patched;
    // Preview text often differs from seed (trim, partial edit, AsyncStorage vs SEED_HABITS).
    const byId = patchObjectFieldById(content, id, fieldName, oldText, newText, true);
    if (byId) return byId;
  }
  return null;
}

function patchConstStringValue(
  content: string,
  ident: string,
  oldText: string,
  newText: string,
): string | null {
  const escapedIdent = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const needles = [oldText, stripEmoji(oldText)].filter(
    (v, i, arr) => Boolean(v) && arr.indexOf(v) === i,
  );
  for (const old of needles) {
    const escapedOld = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `((?:export\\s+)?(?:const|let)\\s+${escapedIdent}\\s*=\\s*)(['"])${escapedOld}\\2`,
    );
    if (re.test(content)) {
      return content.replace(re, `$1$2${newText}$2`);
    }
  }
  return null;
}

/** Patch `key: "old"` inside `const OBJ = { ... }` (e.g. HOME_STRINGS.sectionTitle). */
function patchObjectMemberString(
  content: string,
  objName: string,
  key: string,
  oldText: string,
  newText: string,
): string | null {
  const objEsc = objName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRe = new RegExp(
    `((?:export\\s+)?(?:const|let)\\s+${objEsc}\\s*(?::[^=]+)?=\\s*\\{)([\\s\\S]*?)(\\}\\s*(?:as\\s+const)?\\s*;)`,
  );
  const decl = content.match(declRe);
  if (!decl) return null;

  const body = decl[2];
  const needles = [oldText, stripEmoji(oldText), oldText.trim()].filter(
    (v, i, arr) => Boolean(v) && arr.indexOf(v) === i,
  );
  for (const old of needles) {
    const oldEsc = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fieldRe = new RegExp(`(${keyEsc}\\s*:\\s*)(['"])${oldEsc}\\2`);
    if (fieldRe.test(body)) {
      const newBody = body.replace(fieldRe, `$1$2${newText}$2`);
      return content.replace(declRe, `$1${newBody.replace(/\$/g, "$$$$")}$3`);
    }
  }
  // Trim-tolerant: preview text may differ slightly from source.
  const anyRe = new RegExp(`(${keyEsc}\\s*:\\s*)(['"])([^'"]*)\\2`);
  const anyMatch = body.match(anyRe);
  if (anyMatch && anyMatch[3].trim() === oldText.trim()) {
    const newBody = body.replace(anyRe, `$1$2${newText}$2`);
    return content.replace(declRe, `$1${newBody.replace(/\$/g, "$$$$")}$3`);
  }
  return null;
}

/** <Text testID="...">{APP_NAME}</Text> or {STRINGS.key} — patch the const string, not JSX. */
function patchIdentifierRefText(
  content: string,
  testId: string,
  oldText: string,
  newText: string,
): string | null {
  const el =
    findOpeningTagAtTestId(content, testId) ?? findTemplateTestIdElement(content, testId);
  if (!el || !/<Text\b/.test(el.tag)) return null;
  const bounds = readTextElementBounds(content, el);
  if (!bounds) return null;
  const trimmed = bounds.inner.trim();
  const m = trimmed.match(/^\{([A-Za-z_$][\w$]*)\}$/);
  if (m) return patchConstStringValue(content, m[1], oldText, newText);
  const member = trimmed.match(/^\{([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\}$/);
  if (member) {
    return patchObjectMemberString(content, member[1], member[2], oldText, newText);
  }
  return null;
}

function patchKeyedDataField(
  content: string,
  testId: string,
  oldText: string,
  newText: string,
): string | null {
  const dynamic = splitDynamicTestId(testId);
  if (!dynamic) return null;
  const field = DATA_FIELD_BY_TEST_ID_PREFIX[dynamic.prefix];
  if (!field) return null;
  return patchObjectFieldById(content, dynamic.suffix, field, oldText, newText);
}

function patchObjectFieldById(
  content: string,
  idValue: string,
  fieldName: string,
  oldText: string,
  newText: string,
  idOnly = false,
): string | null {
  const escapedId = idValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(
    `(id:\\s*['"]${escapedId}['"][\\s\\S]{0,1600}?${fieldName}:\\s*)(['"])([^'"]*)\\2`,
  );

  if (!idOnly) {
    const needles = [oldText, stripEmoji(oldText)].filter(
      (v, i, arr) => Boolean(v) && arr.indexOf(v) === i,
    );
    for (const old of needles) {
      const escapedOld = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(
        `(id:\\s*['"]${escapedId}['"][\\s\\S]{0,1600}?${fieldName}:\\s*)(['"])${escapedOld}\\2`,
        "g",
      );
      if (!re.test(content)) continue;
      return content.replace(re, `$1$2${newText}$2`);
    }

    const block = blockRe.exec(content);
    if (block) {
      const current = block[3] ?? "";
      const normalizedOld = (stripEmoji(oldText) || oldText).trim();
      if (current.trim() === normalizedOld) {
        return content.replace(blockRe, `$1$2${newText}$2`);
      }
    }
    return null;
  }

  if (!blockRe.test(content)) return null;
  return content.replace(blockRe, `$1$2${newText}$2`);
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
      // Path 1: literal text in JSX (e.g. <Text>Old Name</Text>).
      const withText = patchTextContent(content, tag, change.value);
      if (withText) {
        content = withText;
        tag = testId ? findOpeningTagAtTestId(content, testId) : null;
        if (!tag) return null;
        opening = tag.tag;
        touched = true;
        continue;
      }
      // Path 2: data-driven text in JSX (e.g. <Text>{UI_STRINGS.tagline}</Text>
      // or <Text>{habit.name}</Text>). Locate the source of the string and
      // rewrite its literal there.
      const withExpression = patchTextByExpression(content, tag, change.value, testId);
      if (withExpression && withExpression !== content) {
        content = withExpression;
        tag = testId ? findOpeningTagAtTestId(content, testId) : null;
        if (!tag) return null;
        opening = tag.tag;
        touched = true;
        continue;
      }
      // Path 3: element renders inside a shared component (AppButton, Card…)
      // and the actual string lives in a property passed via children/title.
      // patchComponentPassthroughInSources handles that case for a different
      // change shape, so we simply return null here.
      return null;
    }

    if (change.type === "background") {
      let patchedBg: string | null = null;
      if (change.screen) {
        patchedBg = patchPageBackgroundInFile(content, change.value);
      } else {
        if (testId) patchedBg = patchBackgroundByTestId(content, testId, change.value);
        if (!patchedBg && change.anchorText) {
          patchedBg = patchBackgroundNearText(content, change.anchorText, change.value, null);
        }
        if (!patchedBg && testId) {
          const el = findOpeningTagAtTestId(content, testId);
          if (el && /<Text\b/.test(el.tag)) {
            patchedBg = patchPageBackgroundInFile(content, change.value);
          }
        }
        if (!patchedBg && change.anchorText && !testId) {
          patchedBg = patchPageBackgroundInFile(content, change.value);
        }
        if (!patchedBg && !testId && !change.anchorText) {
          patchedBg = patchPageBackgroundInFile(content, change.value);
        }
      }
      if (patchedBg) {
        content = patchedBg;
        tag = testId ? findOpeningTagAtTestId(content, testId) : tag;
        opening = tag?.tag ?? opening;
        touched = true;
        continue;
      }
      if (!tag || isSharedMapTemplateElement(content, tag) || isCustomComponentTag(tag.tag)) continue;
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
      if (!tag || isSharedMapTemplateElement(content, tag) || isCustomComponentTag(tag.tag)) continue;
      const next = patchStyleOnTag(opening, "color", change.value);
      if (!next) continue;
      content = replaceTagAt(content, tag, next);
      tag = { start: tag.start, end: tag.start + next.length, tag: next };
      opening = next;
      touched = true;
      continue;
    }

    if (change.type === "fontWeight" || change.type === "fontFamily") {
      const prop = change.type;
      let patched: string | null = null;
      if (change.type === "fontFamily" && change.value === "System") {
        patched = stripTextStylePropByTestId(content, testId, "fontFamily", change.anchorText);
      } else if (testId) {
        patched = patchTextStyleByTestId(
          content,
          testId,
          prop,
          change.value,
          change.anchorText,
        );
      }
      if (patched) {
        content = patched;
        tag = testId ? findOpeningTagAtTestId(content, testId) : tag;
        opening = tag?.tag ?? opening;
        touched = true;
        continue;
      }
      if (!tag || isSharedMapTemplateElement(content, tag) || isCustomComponentTag(tag.tag)) continue;
      const next =
        change.type === "fontFamily" && change.value === "System"
          ? stripStylePropOnTag(opening, "fontFamily")
          : patchStyleOnTag(opening, prop, change.value);
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

const NATIVE_TAGS = new Set([
  "View",
  "Text",
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "ScrollView",
  "SafeAreaView",
  "FlatList",
  "SectionList",
  "Image",
  "ImageBackground",
  "TextInput",
  "KeyboardAvoidingView",
  "Modal",
  "Switch",
  "ActivityIndicator",
]);

/** `<AppButton …>` — styling must happen inside the component file, not here. */
function isCustomComponentTag(tag: string): boolean {
  const name = tag.match(/^<(\w+)/)?.[1];
  return Boolean(name && /^[A-Z]/.test(name) && !NATIVE_TAGS.has(name));
}

/** Split `meal-plan-mon` → prefix `meal-plan`, suffix `mon` (last segment only). */
function splitDynamicTestId(testId: string): { prefix: string; suffix: string } | null {
  const idx = testId.lastIndexOf("-");
  if (idx <= 0) return null;
  const suffix = testId.slice(idx + 1);
  const prefix = testId.slice(0, idx);
  if (!/^[A-Za-z0-9]+$/.test(suffix) || !prefix) return null;
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

  for (const candidate of listItemStyleTestIdCandidates(testId, "backgroundColor")) {
    const listPatched = patchListItemMapStyle(content, candidate, "backgroundColor", color);
    if (listPatched) return listPatched;
  }

  const mapPatched = patchMapItemBackground(content, testId, "backgroundColor", color);
  if (mapPatched) return mapPatched;

  const propPatched = patchPropKeyedBackground(content, testId, color);
  if (propPatched) return propPatched;

  const el = findOpeningTagAtTestId(content, testId);
  if (!el) return null;

  if (isSharedMapTemplateElement(content, el)) return null;

  // A custom component usage (<AppButton …>) takes no style prop here, and
  // walking to the surrounding wrapper paints way more than the user tapped.
  // The component-passthrough strategy patches inside the component instead.
  if (isCustomComponentTag(el.tag)) return null;

  if (isContainerTag(el.tag)) {
    const patched = patchStyleOnTag(el.tag, "backgroundColor", color);
    if (!patched) return null;
    return replaceTagAt(content, el, patched);
  }

  const container = findSmallestContainerBefore(content, el.end);
  if (!container) return null;
  if (isSharedMapTemplateElement(content, container)) return null;
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
    (prop === "color" || prop === "fontWeight" || prop === "fontFamily") &&
    /<Text\b/.test(templateEl.tag)
      ? templateEl
      : isContainerTag(templateEl.tag)
        ? templateEl
        : findSmallestContainerBefore(content, templateEl.end);
  if (!target) return null;

  // Object iterators (`${habit.id}`) need `habit.id === 'h1'`; string iterators
  // (`${day}`) compare the param directly.
  const propRef = templateEl.tag.match(/\$\{(\w+)\.(\w+)[^}]*\}/);
  const keyExpr =
    propRef && propRef[1] === mapParam ? `${mapParam}.${propRef[2]}` : mapParam;

  // No outer braces: inside a style array `{ cond && {...} }` is a syntax error.
  const conditional = `${keyExpr} === '${dayValue}' && { ${prop}: '${color}' }`;
  const patched = appendConditionalStyle(target.tag, conditional, prop, keyExpr, dayValue);
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

/**
 * Find the source location of a testID template that, when populated, would
 * produce the given runtime testId. Unlike `findTemplateTestIdElement`, this
 * does not assume the runtime id is built from a single prefix + suffix —
 * the runtime id may itself contain hyphens, in which case the
 * prefix/suffix split fails. Instead we look at every `testID={\`...\`}`
 * in the source and try to match the static parts against the runtime.
 */
function findRuntimeTestIdByTemplate(
  content: string,
  runtimeTestId: string,
): { start: number; end: number; tag: string } | null {
  const templateRe = /testID=\{`([^`]*)`\}/g;
  let m: RegExpExecArray | null;
  while ((m = templateRe.exec(content)) !== null) {
    const tmpl = m[1];
    // Build a regex from the template with one capture group for each ${...}.
    const subRe = /(\$\{[^}]+\})|([^$`]+|\$|`)/g;
    const parts: { literal: string; capture: boolean }[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = subRe.exec(tmpl)) !== null) {
      if (sm[1]) parts.push({ literal: "", capture: true });
      else if (sm[2]) parts.push({ literal: sm[2], capture: false });
    }
    const composed: string[] = [];
    for (const p of parts) {
      if (p.capture) composed.push("(.+?)");
      else composed.push(p.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    const re = new RegExp("^" + composed.join("") + "$");
    if (re.test(runtimeTestId)) {
      const idx = m.index;
      const tag = walkBackToOpeningTag(content, idx);
      if (tag?.tag.includes("testID")) return tag;
    }
  }
  return null;
}

function findMapIteratorParamBefore(content: string, elStart: number): string | null {
  const windowStart = Math.max(0, elStart - 1500);
  const before = content.slice(windowStart, elStart);
  // Match .map((habit) =>, .map((habit, index) =>, and .map(habit =>
  const re = /\.map\(\s*(?:\(\s*(\w+)(?:\s*,\s*\w+)*\s*\)|(\w+))\s*=>/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before)) !== null) last = m;
  return last ? (last[1] ?? last[2] ?? null) : null;
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
    const arrowPatched = appendToArrowStyle(cleaned, conditional);
    if (!arrowPatched && /=>/.test(cleaned)) return null;
    replacement = arrowPatched ?? `[${cleaned}, ${conditional}]`;
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
  const keyEsc = mapParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const valEsc = dayValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Outer braces optional: handles both the old (broken) braced form and the new bare form.
  const re = new RegExp(
    `,\\s*\\{?\\s*${keyEsc}\\s*===\\s*['"]${valEsc}['"]\\s*&&\\s*\\{\\s*${prop}\\s*:[^}]+\\}\\s*\\}?`,
    "g",
  );
  return styleExpr.replace(re, "");
}

function normalizeTapFontFamily(label: string): string {
  const key = label.trim().toLowerCase();
  if (key === "default" || key === "system" || key === "sans") return "System";
  if (key === "serif") return "Georgia";
  if (key === "monospace" || key === "mono") return "monospace";
  return label.trim();
}

function patchTextColorByTestId(
  content: string,
  testId: string,
  color: string,
  anchorText?: string,
): string | null {
  return patchTextStyleByTestId(content, testId, "color", color, anchorText);
}

function patchTextStyleByTestId(
  content: string,
  testId: string,
  prop: StyleProp,
  value: string,
  anchorText?: string,
): string | null {
  if (!testId || isBroadContainerTestId(testId)) return null;

  if (prop === "color") {
    const propPatched = patchPropKeyedTextColor(content, testId, value, anchorText);
    if (propPatched) return propPatched;
    if (anchorText) {
      const scoped = patchTextColorInContainerByAnchor(content, testId, anchorText, value);
      if (scoped) return scoped;
    }
    for (const candidate of listItemStyleTestIdCandidates(testId, "color")) {
      const listPatched = patchListItemMapStyle(content, candidate, "color", value);
      if (listPatched) return listPatched;
    }
    const mapPatched = patchMapItemBackground(content, testId, "color", value);
    if (mapPatched) return mapPatched;
  } else {
    // List-item conditional first: anchor fallback would style the shared template.
    for (const candidate of listItemStyleTestIdCandidates(testId, prop)) {
      const listPatched = patchListItemMapStyle(content, candidate, prop, value);
      if (listPatched) return listPatched;
    }
    if (anchorText) {
      const scoped = patchTextStyleInContainerByAnchor(content, testId, anchorText, prop, value);
      if (scoped) return scoped;
    }
  }

  const el =
    findOpeningTagAtTestId(content, testId) ??
    findListItemTemplateElement(content, testId);
  if (!el) return null;
  // If the testID is on a non-Text element, look for the first Text in its subtree.
  if (!/<Text\b/.test(el.tag)) {
    const inner = findFirstTextInSubtree(content, el);
    if (inner) {
      const patched = patchStyleOnTag(inner.tag, prop, value);
      if (patched) return replaceTagAt(content, inner, patched);
    }
    return null;
  }

  if (isSharedMapTemplateElement(content, el)) return null;

  const patched = patchStyleOnTag(el.tag, prop, value);
  if (!patched) return null;
  return replaceTagAt(content, el, patched);
}

/** Smallest Text descendant of an opening tag (used when testID sits on a container). */
function findFirstTextInSubtree(
  content: string,
  container: { start: number; end: number; tag: string },
): { start: number; end: number; tag: string } | null {
  const re = /<Text\b/g;
  let m: RegExpExecArray | null;
  let best: { start: number; end: number; tag: string } | null = null;
  let bestDistance = Infinity;
  while ((m = re.exec(content)) !== null) {
    if (m.index <= container.end) continue;
    if (best && m.index - container.end > 4000) break;
    const opening = walkBackToOpeningTag(content, m.index);
    if (!opening) continue;
    best = opening;
    bestDistance = opening.start - container.end;
    if (bestDistance < 200) break;
  }
  return best;
}

function patchTextStyleInContainerByAnchor(
  content: string,
  testId: string,
  anchorText: string,
  prop: StyleProp,
  value: string,
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

  const patched = patchStyleOnTag(hit.tag, prop, value);
  if (!patched) return null;
  return content.slice(0, hit.start) + patched + content.slice(hit.end);
}

function stripTextStylePropByTestId(
  content: string,
  testId: string,
  prop: StyleProp,
  anchorText?: string,
): string | null {
  if (!testId || isBroadContainerTestId(testId)) return null;
  if (anchorText) {
    const container = findOpeningTagAtTestId(content, testId);
    if (!container) return null;
    const subtree = readContainerSubtree(content, container);
    if (!subtree) return null;
    const re = /<Text\b([^>]*)>([\s\S]*?)<\/Text>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(subtree.slice)) !== null) {
      const inner = (m[2] ?? "").trim();
      if (!textInnerMatchesAnchor(inner, anchorText)) continue;
      const absStart = subtree.offset + (m.index ?? 0);
      const parsed = parseOpeningTagAt(content, absStart);
      if (!parsed) continue;
      const stripped = stripStylePropOnTag(parsed.tag, prop);
      if (!stripped) continue;
      return content.slice(0, parsed.start) + stripped + content.slice(parsed.end);
    }
  }
  const el = findOpeningTagAtTestId(content, testId);
  if (!el || !/<Text\b/.test(el.tag)) return null;
  const stripped = stripStylePropOnTag(el.tag, prop);
  if (!stripped) return null;
  return replaceTagAt(content, el, stripped);
}

function stripStylePropOnTag(tag: string, prop: StyleProp): string | null {
  const styleRange = findStyleAttribute(tag);
  if (!styleRange) return null;
  const inner = tag.slice(styleRange.innerStart, styleRange.innerEnd).trim();
  let cleaned = inner;
  if (inner.startsWith("{")) {
    cleaned = stripStylePropFromObject(inner, prop);
  } else if (inner.startsWith("[")) {
    cleaned = stripStyleOverrideFromArray(inner, prop);
  }
  cleaned = cleaned.trim();
  if (!cleaned || cleaned === "[]" || cleaned === "{}") {
    return removeStyleAttributeFromTag(tag);
  }
  return tag.slice(0, styleRange.innerStart) + cleaned + tag.slice(styleRange.innerEnd);
}

function removeStyleAttributeFromTag(tag: string): string {
  const marker = "style=";
  const idx = tag.indexOf(marker);
  if (idx === -1) return tag;
  const braceStart = tag.indexOf("{", idx + marker.length);
  if (braceStart === -1) return tag;
  let depth = 0;
  let quote: string | null = null;
  let braceEnd = -1;
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
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd === -1) return tag;
  const before = tag.slice(0, idx).replace(/\s+$/, "");
  const after = tag.slice(braceEnd + 1);
  return before + after;
}

function stripStylePropFromObject(objExpr: string, prop: StyleProp): string {
  const body = objExpr.replace(/^\{|\}$/g, "").trim();
  const propRe = new RegExp(`,?\\s*${prop}\\s*:\\s*['"\`][^'"\`]*['"\`]`);
  const cleaned = body.replace(propRe, "").replace(/^,\s*/, "").trim();
  if (!cleaned) return "{}";
  return `{ ${cleaned} }`;
}

function patchStyleSheetRuleProp(
  content: string,
  ruleName: string,
  prop: StyleProp,
  value: string,
): string | null {
  const ruleRe = new RegExp(`(${ruleName}:\\s*\\{)([\\s\\S]*?)(\\})`);
  const m = content.match(ruleRe);
  if (!m) return null;
  const body = m[2];
  const propRe = new RegExp(`${prop}\\s*:\\s*[^,\\n}]+`);
  const newBody = propRe.test(body)
    ? body.replace(propRe, `${prop}: '${value}'`)
    : `${body.trim()}${body.trim() ? ", " : ""}${prop}: '${value}'`;
  return content.replace(ruleRe, `${m[1]}${newBody}${m[3]}`);
}

/** Global page color — `colors.groupedBackground` (or legacy `background`) in tokens.ts. */
function patchThemeBackgroundToken(content: string, color: string): string | null {
  if (!/\bexport (?:let|const) colors\b/.test(content)) return null;
  for (const key of ["groupedBackground", "background"]) {
    // Exclude `;`-terminated lines so we never rewrite the TYPE declaration
    // (`groupedBackground: string;`) instead of the runtime value.
    const re = new RegExp(`^(\\s*${key}:\\s*)((?!string\\b)[^,;\\n]+)(,\\s*)$`, "m");
    if (!re.test(content)) continue;
    return content.replace(re, `$1"${color}"$3`);
  }
  return null;
}

/** Root app shell — App.tsx outer View background. */
function patchAppShellBackground(content: string, color: string): string | null {
  if (!/export default function App\b/.test(content)) return null;
  return patchStyleSheetRuleProp(content, "container", "backgroundColor", color);
}

function patchPageBackgroundInFile(content: string, color: string): string | null {
  return (
    patchThemeBackgroundToken(content, color) ??
    patchAppShellBackground(content, color) ??
    patchMainScrollBackground(content, color)
  );
}

/** Patch screen-level background via the main ScrollView / Screen style rule. */
function patchMainScrollBackground(content: string, color: string): string | null {
  const roots = [
    /<ScrollView\b[^>]*\bstyle=\{styles\.(\w+)\}/,
    /<Screen\b[^>]*\bstyle=\{styles\.(\w+)\}/,
    /<SafeAreaView\b[^>]*\bstyle=\{styles\.(\w+)\}/,
  ];
  for (const re of roots) {
    const m = content.match(re);
    if (!m?.[1]) continue;
    const sheetPatched = patchStyleSheetRuleProp(content, m[1], "backgroundColor", color);
    if (sheetPatched) return sheetPatched;
  }

  const scrollIdx = content.search(/<(ScrollView|Screen|SafeAreaView)\b/);
  if (scrollIdx === -1) return null;
  const scrollTag = parseOpeningTagAt(content, scrollIdx);
  if (!scrollTag) return null;
  const inline = patchStyleOnTag(scrollTag.tag, "backgroundColor", color);
  if (!inline) return null;
  return replaceTagAt(content, scrollTag, inline);
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

  if (isSharedMapTemplateElement(content, container)) return null;

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
  const end = scanOpeningTagEnd(content, absStart);
  return { start: absStart, end, tag: content.slice(absStart, end) };
}

/**
 * Index just past the `>` closing an opening tag at `start`. Tracks brace
 * depth so `>` inside JSX expressions (`onPress={() => ...}`) is skipped.
 */
function scanOpeningTagEnd(content: string, start: number): number {
  let end = start + 1;
  let quote: string | null = null;
  let depth = 0;
  while (end < content.length) {
    const c = content[end];
    if (quote) {
      if (c === quote && content[end - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
    } else if (c === ">" && depth <= 0) {
      end++;
      break;
    }
    end++;
  }
  return end;
}

function parseOpeningTagAt(
  content: string,
  start: number,
): { start: number; end: number; tag: string } | null {
  if (content[start] !== "<") return null;
  const end = scanOpeningTagEnd(content, start);
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
  // Match ANY opening tag whose name starts with an uppercase letter — that
  // covers native containers (View, Pressable, …) AND custom components
  // (Card, AppButton, SettingsRow) which are the actual scoped wrapper in
  // the user's app. Limiting to native-only tags used to skip past
  // `<Card testID="home-stat-total">` and land on `<View testID="home-stats">`,
  // painting the whole row.
  const tagRe = /<[A-Z]\w*\b/g;
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
    // Avoid painting the ROOT screen container or app shell by accident.
    const name = parsed.tag.match(/^<(\w+)/)?.[1] ?? "";
    if (isAppShellTag(name, parsed.tag)) continue;
    if (span < bestSpan) {
      bestSpan = span;
      best = parsed;
    }
  }
  return best;
}

function isAppShellTag(name: string, tag: string): boolean {
  // `Screen`, `App`, root layout wrappers. They sit just inside the file
  // and would otherwise capture every "background" tap.
  return /^(Screen|App|Root)$/.test(name) || /\btestID="[^"]*-screen"/.test(tag);
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
    const listPatched = patchListItemDataField(content, testId, oldText, newText);
    if (listPatched) return listPatched;

    const dataPatched = patchKeyedDataField(content, testId, oldText, newText);
    if (dataPatched) return dataPatched;

    const propPatched = patchPropKeyedText(content, testId, oldText, newText);
    if (propPatched) return propPatched;

    const mapPatched = patchMapItemText(content, testId, oldText, newText);
    if (mapPatched) return mapPatched;

    const byId = patchTextElementByTestId(content, testId, newText, oldText);
    if (byId) return byId;

    const constRef = patchIdentifierRefText(content, testId, oldText, newText);
    if (constRef) return constRef;

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

  const end = scanOpeningTagEnd(content, start);
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

  // Fallback: try to match the runtime testID against any testID template
  // literal in the source. Handles cases like
  //   testID={`home-habit-${habit.id}-name`} → home-habit-habit-pushups-name
  // where the existing prefix-suffix split can't recover the static prefix
  // (because the runtime id itself contains a hyphen).
  const templateEl = findRuntimeTestIdByTemplate(content, testId);
  if (templateEl) return templateEl;

  // Runtime IDs from templates like `week-day-${day}` → week-day-Tue
  const templateEl2 = findTemplateTestIdElement(content, testId);
  if (templateEl2) return templateEl2;

  const listItemEl = findListItemTemplateElement(content, testId);
  if (listItemEl) return listItemEl;

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

/**
 * Function styles — `style={({ pressed }) => [styles.row, pressed && styles.pressed]}` —
 * must get additions INSIDE the returned array. RN silently ignores a function
 * nested in a style array, so wrapping would "save" with zero visual effect.
 */
function appendToArrowStyle(inner: string, addition: string): string | null {
  const arrow =
    inner.match(/^(\(\s*\{?[^)]*\}?\s*\)\s*=>\s*)([\s\S]*)$/) ??
    inner.match(/^([A-Za-z_$][\w$]*\s*=>\s*)([\s\S]*)$/);
  if (!arrow) return null;
  const head = arrow[1];
  let body = arrow[2].trim();
  const parenWrapped = body.startsWith("(") && body.endsWith(")");
  if (parenWrapped) body = body.slice(1, -1).trim();

  let newBody: string;
  if (body.startsWith("[") && body.endsWith("]")) {
    const arrBody = body.slice(1, -1).trim();
    newBody = arrBody ? `[${arrBody}, ${addition}]` : `[${addition}]`;
  } else if (body && !body.startsWith("{")) {
    newBody = `[${body}, ${addition}]`;
  } else {
    return null;
  }
  return `${head}${parenWrapped ? `(${newBody})` : newBody}`;
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
    const arrowPatched = appendToArrowStyle(stripStyleOverrideFromArray(inner, prop), override);
    replacement = arrowPatched ?? `[${inner}, ${override}]`;
    if (!arrowPatched && /=>/.test(inner)) return null;
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
  const inline = new RegExp(`\\{\\s*${prop}\\s*:\\s*['"\`][^'"\`]*['"\`]\\s*\\}`, "g");
  let out = arrayExpr.replace(inline, "");
  out = out.replace(/,\s*,/g, ",");
  out = out.replace(/\[\s*,/g, "[");
  out = out.replace(/,\s*\]/g, "]");
  return out;
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

/**
 * When the JSX body of a tapped element is `{EXPR}` (e.g. `{UI_STRINGS.tagline}`
 * or `{habit.name}`) we cannot just replace the body. Instead, we locate the
 * *source of the string* and patch the literal there. This handles the common
 * M3-build pattern where every label sits in a typed `UI_STRINGS` constant or
 * a seed `habits` array.
 *
 * Returns the updated content if a literal was found and rewritten, else null.
 */
function patchTextByExpression(
  content: string,
  tag: TagSpan,
  newText: string,
  runtimeTestId: string | null,
): string | null {
  const opening = content.slice(tag.start, tag.end);
  if (opening.trimEnd().endsWith("/>")) return null;

  const tagName = opening.match(/^<(\w+)/)?.[1];
  if (!tagName) return null;

  const closeRe = new RegExp(`</${tagName}>`, "g");
  closeRe.lastIndex = tag.end;
  const close = closeRe.exec(content);
  if (!close) return null;

  const inner = content.slice(tag.end, close.index).trim();
  // Must be a single expression of the form `{EXPR}`.
  const exprMatch = inner.match(/^\{([\s\S]+)\}$/);
  if (!exprMatch) return null;
  const expr = exprMatch[1].trim();
  if (expr.includes("{")) return null; // nested expressions, not handled

  // Strategy A: CONSTANT.FIELD (e.g. UI_STRINGS.tagline, LABELS.heroTitle).
  // The body looks like `IDENT.field` and IDENT is a top-level const in this
  // file. We rewrite the property's literal value.
  const dottedMatch = expr.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
  if (dottedMatch) {
    const [, ident, field] = dottedMatch;

    // A.1) Local constant in this file (UI_STRINGS, LABELS, labels, etc.)
    const localConst = patchLocalConstantString(content, ident, field, newText);
    if (localConst) return localConst;

    // A.2) Local data array indexed by id (habit.name, s.tagline, etc.).
    // The runtime testID contains a known id segment that we extract.
    if (runtimeTestId) {
      const idSegment = extractIdFromTestId(content, runtimeTestId);
      if (idSegment) {
        // First, try the ident as-is (works when the iterator shares the
        // name of the array: `array.map((array) => ...)`).
        const direct = patchLocalDataField(content, ident, field, idSegment, newText);
        if (direct) return direct;
        // Then, try common variations. The most common pattern is
        // `const habits = [...]; habits.map((habit) => ...)` where the
        // iterator (`habit`) differs from the array (`habits`).
        const candidates: string[] = [];
        if (ident.endsWith("s")) candidates.push(ident.slice(0, -1));
        else candidates.push(ident + "s");
        for (const candidate of candidates) {
          const r = patchLocalDataField(content, candidate, field, idSegment, newText);
          if (r) return r;
        }
      }
    }
  }

  // Strategy B: bare IDENT (e.g. just `{tagline}` shorthand) - we don't yet
  // resolve these to local data arrays; the JSX would have to be a destructure
  // pattern which is rare in tappable UI.
  return null;
}

/**
 * Patch a string property of a local constant object.
 * Recognises forms:
 *   const UI_STRINGS = { tagline: "Stay sharp" };
 *   export const UI_STRINGS: { tagline: string } = { tagline: "Stay sharp" };
 *   const LABELS = { heroTitle: "Welcome", heroSubtitle: "Hi" };
 * Also handles `as const`, multi-line objects, and trailing semicolons.
 */
function patchLocalConstantString(
  content: string,
  ident: string,
  field: string,
  newText: string,
): string | null {
  // Find the constant declaration: `const IDENT = { ... }` or `: T = { ... }`.
  // The object literal may span many lines; we balance braces.
  const declRe = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?const\\s+${ident}\\b[^{=]*=\\s*\\{`,
    "g",
  );
  const declMatch = declRe.exec(content);
  if (!declMatch) return null;
  const openBrace = declMatch.index + declMatch[0].length - 1;
  // Walk forward, tracking brace depth, to find the matching close brace.
  let depth = 1;
  let i = openBrace + 1;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && content[i + 1] === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === "/" && content[i + 1] === "/") { inLineComment = true; i += 2; continue; }
    if (ch === "/" && content[i + 1] === "*") { inBlockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;
  const closeBrace = i - 1;
  const objectSrc = content.slice(openBrace, closeBrace + 1);

  // Find `field: "currentValue"` inside the object.
  const fieldRe = new RegExp(
    `(\\b${field}\\s*:\\s*)(["'\`])((?:\\\\.|(?!\\2).)*)\\2`,
  );
  const fieldMatch = fieldRe.exec(objectSrc);
  if (!fieldMatch) return null;
  const fullMatch = fieldMatch[0];
  const prefix = fieldMatch[1];
  const quote = fieldMatch[2];
  const oldValue = fieldMatch[3];
  // Skip if the field is a template literal with substitutions or if value
  // contains JS expressions.
  if (quote === "`" && oldValue.includes("${")) return null;

  // JSON-escape the new text to keep the literal well-formed.
  const escaped = newText
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

  const replacement = `${prefix}${quote}${escaped}${quote}`;
  const newObject = objectSrc.replace(fullMatch, replacement);
  return content.slice(0, openBrace) + newObject + content.slice(closeBrace + 1);
}

/**
 * Patch a field of an item inside a local data array, identified by id.
 * Recognises forms:
 *   const habits = [
 *     { id: "habit-morning-run", name: "Morning Run" },
 *     { id: "habit-pushups", name: "Pushups" },
 *   ];
 *   habits.find(h => h.id === "habit-morning-run") // doesn't change the array
 *
 * The testID template for habit names is typically:
 *   testID={`home-habit-${habit.id}-name`}      → runtime: home-habit-habit-morning-run-name
 *   testID={`${item.id}-name`}                  → runtime: item.id-name
 *
 * We only patch the *first* literal object whose `id` field matches the
 * extracted id segment.
 */
function patchLocalDataField(
  content: string,
  ident: string,
  field: string,
  idSegment: string,
  newText: string,
): string | null {
  // Look for an array literal: `const IDENT = [ { id: "X", name: "Y" }, ... ]`
  // or a const whose value is an object map { id: { ... } }.
  const arrayRe = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?const\\s+${ident}\\b[^{=]*=\\s*\\[`,
    "g",
  );
  const arrayMatch = arrayRe.exec(content);
  if (!arrayMatch) return null;
  const openBracket = arrayMatch.index + arrayMatch[0].length - 1;
  const balanceEnd = findBalancedEnd(content, openBracket, "[", "]");
  if (balanceEnd === -1) return null;
  const arraySrc = content.slice(openBracket, balanceEnd + 1);

  // Find the first object literal whose `id` field equals idSegment.
  // We do a per-object scan because objects can span multiple lines.
  const escapedId = idSegment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Try both single and double-quoted ids.
  const idRe = new RegExp(`\\bid\\s*:\\s*(["'\`])${escapedId}\\1`, "g");
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(arraySrc)) !== null) {
    // Walk back to find the start of the object literal `{`.
    const objStart = findObjectStart(arraySrc, m.index);
    if (objStart === -1) continue;
    // Walk forward to the matching `}`.
    const objEnd = findBalancedEnd(arraySrc, objStart, "{", "}");
    if (objEnd === -1) continue;
    const objSrc = arraySrc.slice(objStart, objEnd + 1);
    // Inside this object, find `field: "value"`.
    const fieldRe = new RegExp(
      `(\\b${field}\\s*:\\s*)(["'\`])((?:\\\\.|(?!\\2).)*)\\2`,
    );
    const fieldMatch = fieldRe.exec(objSrc);
    if (!fieldMatch) continue;
    const fullMatch = fieldMatch[0];
    const prefix = fieldMatch[1];
    const quote = fieldMatch[2];
    if (quote === "`" && fieldMatch[3].includes("${")) continue;

    const escaped = newText.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const newObj = objSrc.replace(fullMatch, `${prefix}${quote}${escaped}${quote}`);
    const newArray = arraySrc.slice(0, objStart) + newObj + arraySrc.slice(objEnd + 1);
    return content.slice(0, openBracket) + newArray + content.slice(balanceEnd + 1);
  }
  return null;
}

/** Find the index of the matching close bracket/brace, or -1. */
function findBalancedEnd(content: string, openIdx: number, open: string, close: string): number {
  let depth = 1;
  let i = openIdx + 1;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (inLineComment) { if (ch === "\n") inLineComment = false; i++; continue; }
    if (inBlockComment) {
      if (ch === "*" && content[i + 1] === "/") { inBlockComment = false; i += 2; continue; }
      i++; continue;
    }
    if (inString) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === inString) inString = null;
      i++; continue;
    }
    if (ch === "/" && content[i + 1] === "/") { inLineComment = true; i += 2; continue; }
    if (ch === "/" && content[i + 1] === "*") { inBlockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; i++; continue; }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    i++;
  }
  if (depth !== 0) return -1;
  return i - 1;
}

/** Find the index of the `{` that opens the object containing idx. */
function findObjectStart(content: string, idx: number): number {
  // Walk back, tracking depth of `{}`, ignoring those inside strings/comments.
  let depth = 1; // we know we're inside an object whose id field is at idx
  let i = idx - 1;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i >= 0) {
    const ch = content[i];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i--; continue;
    }
    if (inBlockComment) {
      if (ch === "/" && content[i - 1] === "*") inBlockComment = false;
      i--; continue;
    }
    if (inString) {
      if (ch === "\\") { i -= 2; continue; }
      if (ch === inString) inString = null;
      i--; continue;
    }
    // Reverse string detection: look for a quote preceded by an even number
    // of backslashes.
    if (ch === '"' || ch === "'" || ch === "`") {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && content[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 0) inString = ch;
      i--; continue;
    }
    if (ch === "/" && content[i - 1] === "/") { inLineComment = true; i -= 2; continue; }
    if (ch === "/" && content[i - 1] === "*") { inBlockComment = true; i -= 2; continue; }
    if (ch === "}") { depth++; i--; continue; }
    if (ch === "{") { depth--; if (depth === 0) return i; i--; continue; }
    i--;
  }
  return -1;
}

/**
 * Extract a likely item id from a runtime testID that came from a template
 * literal like `home-habit-${habit.id}-name`. The strategy is to look for
 * the testID template in the source so we know the static prefix, then
 * everything between prefix and the last suffix is the id.
 *
 * For runtime testID `home-habit-habit-pushups-name` we want the leaf
 * id `habit-pushups` to look up in the data array.
 */
function extractIdFromTestId(
  content: string,
  runtimeTestId: string | null,
): string | null {
  if (!runtimeTestId) return null;
  // Find the testID template literal in the source. The static portion is
  // everything outside `${...}` and the dynamic portion is whatever the
  // runtime substituted. We split the runtime testID using the same static
  // anchors to recover the dynamic value.
  const templateRe = /testID=\{`([^`]*)\`\}/g;
  let m: RegExpExecArray | null;
  while ((m = templateRe.exec(content)) !== null) {
    const tmpl = m[1];
    // Build a regex from the template with one capture group for each ${...}.
    const subRe = /(\$\{[^}]+\})|([^$`]+|\$|`)/g;
    const parts: { literal: string; capture: boolean }[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = subRe.exec(tmpl)) !== null) {
      if (sm[1]) parts.push({ literal: "", capture: true });
      else if (sm[2]) parts.push({ literal: sm[2], capture: false });
    }
    // Compose: ^literal(capture)literal(capture)literal$ with capture groups.
    const composed: string[] = [];
    const captureIdxs: number[] = [];
    for (const p of parts) {
      if (p.capture) {
        captureIdxs.push(composed.length);
        composed.push("(.+?)");
      } else {
        composed.push(p.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      }
    }
    const re = new RegExp("^" + composed.join("") + "$");
    const match = runtimeTestId.match(re);
    if (match) {
      // The dynamic value is the capture group corresponding to the last
      // ${...} in the template (typically the only one).
      const captured = match[captureIdxs[captureIdxs.length - 1]];
      if (captured) return captured;
    }
  }
  // Fallback: strip a known suffix.
  const suffixes = ["-name", "-row", "-card", "-label", "-text", "-title", "-subtitle", "-header"];
  for (const s of suffixes) {
    if (runtimeTestId.endsWith(s)) {
      return runtimeTestId.slice(0, -s.length);
    }
  }
  return null;
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
    } else if (c.type === "fontWeight") {
      parts.push(c.value === "700" ? "the text is bold now" : "the text is normal weight now");
    } else if (c.type === "fontFamily") {
      parts.push(
        c.value === "System" ? "the font is back to default" : `the font is now ${c.value}`,
      );
    } else if (c.type === "background") {
      parts.push(c.screen ? "the screen background color is updated" : "the background color is updated");
    } else if (c.type === "removeIcon") {
      parts.push("the icon is removed");
    }
  }
  if (parts.length === 0) return "Done - your change is in!";
  if (parts.length === 1) return `Done - ${parts[0]}.`;
  return `Done - ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

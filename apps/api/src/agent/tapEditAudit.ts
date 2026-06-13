import { listProjectFiles, readProjectFile } from "../orchestrator.js";

export type TapEditAuditIssueKind =
  | "text-missing-testid"
  | "pressable-missing-testid"
  | "title-split-across-text"
  | "day-display-hack"
  | "special-case-title-render"
  | "prop-text-bad-testid"
  | "hardcoded-user-text"
  | "rogue-tab-route"
  | "icon-missing-testid"
  | "raw-color-literal";

export interface TapEditAuditIssue {
  file: string;
  line: number;
  kind: TapEditAuditIssueKind;
  snippet: string;
}

const AUDIT_GLOBS = [
  /^app\/\(tabs\)\/.+\.(tsx|jsx)$/,
  /^app\/\(stack\)\/.+\.(tsx|jsx)$/,
  /^(src\/screens|src\/components)\/.+\.(tsx|jsx)$/,
  /^src\/lib\/.+\.(tsx|ts)$/,
  /^App\.tsx$/,
];

const TAB_BAR_ONLY = new Set(["index", "settings"]);

/** Secondary screens under (tabs)/ leak into the tab bar — belong in app/(stack)/. */
function findRogueTabRouteIssues(file: string): TapEditAuditIssue[] {
  const norm = file.replace(/\\/g, "/");
  if (!norm.startsWith("app/(tabs)/")) return [];
  if (norm === "app/(tabs)/_layout.tsx") return [];
  const rel = norm.slice("app/(tabs)/".length);
  if (!/\.(tsx|jsx)$/.test(rel)) return [];
  const routeName = rel.replace(/\.(tsx|jsx)$/, "");
  if (TAB_BAR_ONLY.has(routeName)) return [];
  return [
    {
      file: norm,
      line: 1,
      kind: "rogue-tab-route",
      snippet: `Move to app/(stack)/${rel} — only Home + Settings belong in (tabs)/`,
    },
  ];
}
const SKIP_TEXT_STYLE_KEYS = new Set([
  "legalText",
  "footerText",
  "footerSubtext",
  "legalContent",
]);

const FULL_DAY_NAMES =
  /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/;

/** `{item.name}` in Text → testID must end with `-name` (or `-title`, `-label`, `-desc`). */
const PROP_FIELD_TESTID_SUFFIX: Record<string, string> = {
  name: "name",
  title: "title",
  label: "label",
  description: "desc",
};

const HARDCODED_TEXT_ALLOW = new Set([
  "Loading...",
  "Loading",
  "Done",
  "Tap",
  "...",
  "Settings",
  "Home",
  "Habits",
  "Go back",
  "Something went wrong.",
  "Habit not found",
  "Delete Habit",
  "Delete",
  "Cancel",
]);

function testIdHasFieldSuffix(attrs: string, suffix: string): boolean {
  return (
    attrs.includes(`-${suffix}\``) ||
    attrs.includes(`-${suffix}"`) ||
    attrs.includes(`-${suffix}'`) ||
    attrs.includes(`-${suffix}}`)
  );
}

function findPropTextTestIdIssues(content: string, file: string): TapEditAuditIssue[] {
  const issues: TapEditAuditIssue[] = [];
  const re = /<Text\b([^>]*)>([\s\S]*?)<\/Text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const attrs = m[1] ?? "";
    const inner = (m[2] ?? "").trim();
    const prop = inner.match(/^\{(\w+)\.(\w+)\}$/);
    if (!prop) continue;
    const suffix = PROP_FIELD_TESTID_SUFFIX[prop[2]];
    if (!suffix) continue;
    if (!/testID\s*=/.test(attrs)) continue;
    if (testIdHasFieldSuffix(attrs, suffix)) continue;
    issues.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "prop-text-bad-testid",
      snippet: `<Text${attrs}>${inner}</Text>`.replace(/\s+/g, " ").trim().slice(0, 140),
    });
  }
  return issues;
}

/** User copy as JSX literal — should live in storage.ts and render as {item.field}. */
function findHardcodedUserTextIssues(content: string, file: string): TapEditAuditIssue[] {
  const issues: TapEditAuditIssue[] = [];
  const re = /<Text\b([^>]*)>([\s\S]*?)<\/Text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const attrs = m[1] ?? "";
    if (!/testID\s*=/.test(attrs)) continue;
    const inner = (m[2] ?? "").trim();
    if (inner.includes("{")) continue;
    const text = inner.replace(/^["']|["']$/g, "").trim();
    if (text.length < 10) continue;
    if (HARDCODED_TEXT_ALLOW.has(text)) continue;
    if (/^[\d./%-]+$/.test(text)) continue;
    issues.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "hardcoded-user-text",
      snippet: `<Text${attrs}>${text.slice(0, 40)}</Text>`.replace(/\s+/g, " ").trim().slice(0, 140),
    });
  }
  return issues;
}

function isAuditableFile(path: string): boolean {
  return AUDIT_GLOBS.some((re) => re.test(path.replace(/\\/g, "/")));
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
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

function shouldSkipTextTag(tag: string): boolean {
  if (/testID\s*=/.test(tag)) return false;
  const styleKey = tag.match(/styles\.(\w+)/)?.[1];
  if (styleKey && SKIP_TEXT_STYLE_KEYS.has(styleKey)) return true;
  return false;
}

function findTextIssues(content: string, file: string): TapEditAuditIssue[] {
  const issues: TapEditAuditIssue[] = [];
  const re = /<Text\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const parsed = parseOpeningTagAt(content, m.index);
    if (!parsed) continue;
    if (/testID\s*=/.test(parsed.tag)) continue;
    if (shouldSkipTextTag(parsed.tag)) continue;
    issues.push({
      file,
      line: lineNumberAt(content, parsed.start),
      kind: "text-missing-testid",
      snippet: parsed.tag.replace(/\s+/g, " ").trim().slice(0, 140),
    });
  }
  return issues;
}

/** Pressable rows inside .map() should expose a testID template for tap-to-edit. */
function findPressableIssues(content: string, file: string): TapEditAuditIssue[] {
  if (!content.includes(".map(")) return [];
  const issues: TapEditAuditIssue[] = [];
  const re = /<(Pressable|TouchableOpacity)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const parsed = parseOpeningTagAt(content, m.index);
    if (!parsed) continue;
    const before = content.slice(Math.max(0, parsed.start - 800), parsed.start);
    if (!/\.map\s*\(/.test(before)) continue;

    if (!/testID\s*=/.test(parsed.tag)) {
      issues.push({
        file,
        line: lineNumberAt(content, parsed.start),
        kind: "pressable-missing-testid",
        snippet: parsed.tag.replace(/\s+/g, " ").trim().slice(0, 140),
      });
      continue;
    }

    const hasRowSuffix =
      /-(row|card|item|pressable)\`/.test(parsed.tag) ||
      /-(row|card|item|pressable)"/.test(parsed.tag);
    if (!hasRowSuffix) {
      issues.push({
        file,
        line: lineNumberAt(content, parsed.start),
        kind: "pressable-missing-testid",
        snippet: `Mapped row needs -row/-card testID suffix: ${parsed.tag.replace(/\s+/g, " ").trim().slice(0, 100)}`,
      });
    }
  }
  return issues;
}

/**
 * One label broken into multiple Text nodes (e.g. title.split + fragment of Text spans).
 */
function findSplitTitleIssues(content: string, file: string): TapEditAuditIssue[] {
  const issues: TapEditAuditIssue[] = [];
  const re = /\.split\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const slice = content.slice(m.index, m.index + 700);
    const textTags = (slice.match(/<Text\b/g) || []).length;
    if (textTags >= 2 && (slice.includes("<>") || slice.includes("Fragment"))) {
      issues.push({
        file,
        line: lineNumberAt(content, m.index),
        kind: "title-split-across-text",
        snippet: slice.replace(/\s+/g, " ").trim().slice(0, 140),
      });
    }
  }

  const nestedTitleRe = /<Text\b[^>]*testID\s*=\s*[\{`"'][^>`"']*title[^>`"']*[\}`"'][^>]*>[\s\n]*</g;
  while ((m = nestedTitleRe.exec(content)) !== null) {
    issues.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "title-split-across-text",
      snippet: content
        .slice(m.index, m.index + 120)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140),
    });
  }

  return issues;
}

/** `day === 'Mon' ? "Monday" : day` — breaks tap-to-edit; use {day} from days array. */
function findDayDisplayHackIssues(content: string, file: string): TapEditAuditIssue[] {
  const issues: TapEditAuditIssue[] = [];
  const re =
    /(\w+)\s*===\s*['"][^'"]+['"]\s*\?\s*["'][^"']+["']\s*:\s*\1\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const snippet = content.slice(m.index, m.index + 80).replace(/\s+/g, " ").trim();
    if (!FULL_DAY_NAMES.test(snippet) && m[0].length < 12) continue;
    issues.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "day-display-hack",
      snippet,
    });
  }
  return issues;
}

/** renderTitle() with per-item string splits — merge to one Text + data source. */
function findSpecialCaseTitleRender(content: string, file: string): TapEditAuditIssue[] {
  const issues: TapEditAuditIssue[] = [];
  const re = /(?:const|function)\s+renderTitle\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    issues.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "special-case-title-render",
      snippet: content
        .slice(m.index, m.index + 100)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140),
    });
  }
  return issues;
}

/**
 * Icons from @expo/vector-icons MUST carry a testID (rule 7b). An icon without
 * a testID is the most common source of "I tapped the icon and it changed the
 * row behind it" — the bridge has nothing to route the click to, so it falls
 * back to the parent container.
 */
function findIconMissingTestIdIssues(content: string, file: string): TapEditAuditIssue[] {
  const issues: TapEditAuditIssue[] = [];
  const re = /<(Ionicons|MaterialIcons|MaterialCommunityIcons|Feather|AntDesign|Entypo|FontAwesome|Foundation|Octicons|SimpleLineIcons|Zocial)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const parsed = parseOpeningTagAt(content, m.index);
    if (!parsed) continue;
    if (/testID\s*=/.test(parsed.tag)) continue;
    issues.push({
      file,
      line: lineNumberAt(content, parsed.start),
      kind: "icon-missing-testid",
      snippet: parsed.tag.replace(/\s+/g, " ").trim().slice(0, 140),
    });
  }
  return issues;
}

/**
 * `color: "#fff"` or `backgroundColor: 'red'` hardcoded in a style object.
 * Tap-to-edit mutates the `colors` object, so a literal here would not change
 * when the user picks a new color — classic "I changed the color and nothing
 * happened" mislabel. Replace with `colors.something` (or another token).
 */
function findRawColorLiteralIssues(content: string, file: string): TapEditAuditIssue[] {
  const issues: TapEditAuditIssue[] = [];
  const re = /\b(color|backgroundColor|borderColor|tintColor|fillColor|strokeColor)\s*:\s*["'](?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const before = content.slice(Math.max(0, m.index - 200), m.index);
    if (!/StyleSheet\.create\b|\bstyles\s*[:=]/.test(before)) continue;
    issues.push({
      file,
      line: lineNumberAt(content, m.index),
      kind: "raw-color-literal",
      snippet: content
        .slice(m.index, m.index + 80)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140),
    });
  }
  return issues;
}

/** Scan one file's source (unit tests + live audit). */
export function auditFileContent(content: string, file: string): TapEditAuditIssue[] {
  if (!isAuditableFile(file)) return [];
  return [
    ...findTextIssues(content, file),
    ...findPressableIssues(content, file),
    ...findPropTextTestIdIssues(content, file),
    ...findHardcodedUserTextIssues(content, file),
    ...findSplitTitleIssues(content, file),
    ...findDayDisplayHackIssues(content, file),
    ...findSpecialCaseTitleRender(content, file),
    ...findIconMissingTestIdIssues(content, file),
    ...findRawColorLiteralIssues(content, file),
  ];
}

export async function auditTapEditReadiness(projectId: string): Promise<TapEditAuditIssue[]> {
  const files = await listProjectFiles(projectId);
  const issues: TapEditAuditIssue[] = [];

  for (const file of files) {
    issues.push(...findRogueTabRouteIssues(file));
    if (!isAuditableFile(file)) continue;
    const content = await readProjectFile(projectId, file);
    issues.push(...auditFileContent(content, file));
  }

  return issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const KIND_LABELS: Record<TapEditAuditIssueKind, string> = {
  "text-missing-testid": "Text without testID",
  "pressable-missing-testid": "list row without testID",
  "prop-text-bad-testid": "data field Text missing -name/-title suffix on testID",
  "hardcoded-user-text": "user copy hardcoded in JSX (use storage.ts)",
  "title-split-across-text": "split title across Text nodes",
  "day-display-hack": "day display override ternary",
  "special-case-title-render": "special-case renderTitle()",
  "rogue-tab-route": "screen in app/(tabs)/ but not Home/Settings — use app/(stack)/",
  "icon-missing-testid": "icon without testID (chevrons, close buttons etc.)",
  "raw-color-literal": "hardcoded color in StyleSheet — tap-edit won't change it",
};

/** Human + agent readable report (capped). */
export function formatTapEditAuditReport(
  issues: TapEditAuditIssue[],
  maxItems = 30,
): string {
  if (issues.length === 0) {
    return "Tap-edit hygiene: all checks passed (testIDs, data layout, no split labels).";
  }

  const counts = new Map<TapEditAuditIssueKind, number>();
  for (const issue of issues) {
    counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([kind, n]) => `${n} ${KIND_LABELS[kind]}`)
    .join(", ");

  const lines = [
    `Tap-edit hygiene audit: ${issues.length} issue(s) — ${summary}.`,
    "Fix so every tap-to-edit change saves to code (rule 7b).",
    "- One label = one Text; editable strings in data (storage.ts, tabs arrays).",
    "- testID on every label and mapped row; icon beside label in a row.",
    "- Data-driven labels: {item.name} → testID ends with -name (e.g. `home-habit-${id}-name`).",
    "- User-visible strings in storage.ts / data arrays — not JSX literals.",
    "- No day === 'Mon' ? \"Monday\" : day hacks; no title.split() fragments.",
    "",
  ];

  for (const issue of issues.slice(0, maxItems)) {
    lines.push(`- ${issue.file}:${issue.line} [${issue.kind}] ${issue.snippet}`);
  }
  if (issues.length > maxItems) {
    lines.push(`... and ${issues.length - maxItems} more`);
  }
  return lines.join("\n");
}

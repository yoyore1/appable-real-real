import { listProjectFiles, readProjectFile } from "../orchestrator.js";

export type TapEditAuditIssueKind =
  | "text-missing-testid"
  | "pressable-missing-testid"
  | "title-split-across-text"
  | "day-display-hack"
  | "special-case-title-render";

export interface TapEditAuditIssue {
  file: string;
  line: number;
  kind: TapEditAuditIssueKind;
  snippet: string;
}

const AUDIT_GLOBS = [
  /^(src\/screens|src\/components)\/.+\.(tsx|jsx)$/,
  /^src\/lib\/.+\.(tsx|ts)$/,
  /^App\.tsx$/,
];

/** Style keys used for long legal/footer copy — tap-to-edit targets labels, not these. */
const SKIP_TEXT_STYLE_KEYS = new Set([
  "legalText",
  "footerText",
  "footerSubtext",
  "legalContent",
]);

const FULL_DAY_NAMES =
  /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/;

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
    if (/testID\s*=/.test(parsed.tag)) continue;
    const before = content.slice(Math.max(0, parsed.start - 800), parsed.start);
    if (!/\.map\s*\(/.test(before)) continue;
    issues.push({
      file,
      line: lineNumberAt(content, parsed.start),
      kind: "pressable-missing-testid",
      snippet: parsed.tag.replace(/\s+/g, " ").trim().slice(0, 140),
    });
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

/** Scan one file's source (unit tests + live audit). */
export function auditFileContent(content: string, file: string): TapEditAuditIssue[] {
  if (!isAuditableFile(file)) return [];
  return [
    ...findTextIssues(content, file),
    ...findPressableIssues(content, file),
    ...findSplitTitleIssues(content, file),
    ...findDayDisplayHackIssues(content, file),
    ...findSpecialCaseTitleRender(content, file),
  ];
}

export async function auditTapEditReadiness(projectId: string): Promise<TapEditAuditIssue[]> {
  const files = await listProjectFiles(projectId);
  const issues: TapEditAuditIssue[] = [];

  for (const file of files) {
    if (!isAuditableFile(file)) continue;
    const content = await readProjectFile(projectId, file);
    issues.push(...auditFileContent(content, file));
  }

  return issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const KIND_LABELS: Record<TapEditAuditIssueKind, string> = {
  "text-missing-testid": "Text without testID",
  "pressable-missing-testid": "list row without testID",
  "title-split-across-text": "split title across Text nodes",
  "day-display-hack": "day display override ternary",
  "special-case-title-render": "special-case renderTitle()",
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

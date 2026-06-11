import { listProjectFiles, readProjectFile } from "../orchestrator.js";

export interface TapEditAuditIssue {
  file: string;
  line: number;
  kind: "text-missing-testid" | "pressable-missing-testid";
  snippet: string;
}

const AUDIT_GLOBS = [/^(src\/screens|src\/components)\/.+\.(tsx|jsx)$/, /^App\.tsx$/];

/** Style keys used for long legal/footer copy — tap-to-edit targets labels, not these. */
const SKIP_TEXT_STYLE_KEYS = new Set([
  "legalText",
  "footerText",
  "footerSubtext",
  "legalContent",
]);

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

/** Scan one file's source (unit tests + live audit). */
export function auditFileContent(content: string, file: string): TapEditAuditIssue[] {
  if (!isAuditableFile(file)) return [];
  return [...findTextIssues(content, file), ...findPressableIssues(content, file)];
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

/** Human + agent readable report (capped). */
export function formatTapEditAuditReport(
  issues: TapEditAuditIssue[],
  maxItems = 30,
): string {
  if (issues.length === 0) return "All checked Text and list rows have testIDs.";

  const textMissing = issues.filter((i) => i.kind === "text-missing-testid").length;
  const rowMissing = issues.filter((i) => i.kind === "pressable-missing-testid").length;

  const lines = [
    `Tap-to-edit audit: ${issues.length} issue(s) — ${textMissing} Text without testID, ${rowMissing} list row(s) without testID.`,
    "Add unique kebab-case testID props so customers can tap labels and colors in the preview.",
    "Examples: testID=\"settings-meal-reminder-label\", testID={\`meal-plan-\${id}\`} on mapped rows.",
    "",
  ];

  for (const issue of issues.slice(0, maxItems)) {
    lines.push(
      `- ${issue.file}:${issue.line} [${issue.kind}] ${issue.snippet}`,
    );
  }
  if (issues.length > maxItems) {
    lines.push(`... and ${issues.length - maxItems} more`);
  }
  return lines.join("\n");
}

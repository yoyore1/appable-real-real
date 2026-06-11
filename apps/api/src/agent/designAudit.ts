import type { AppSpec } from "@appable/shared";
import { listProjectFiles, readProjectFile } from "../orchestrator.js";

export type DesignAuditIssueKind =
  | "emoji-as-icon"
  | "placeholder-copy"
  | "missing-auth-module"
  | "missing-sign-in"
  | "missing-sign-out"
  | "missing-delete-account"
  | "missing-role-picker"
  | "missing-theme-tokens"
  | "missing-storage-module"
  | "missing-base-components"
  | "missing-font-load"
  | "hardcoded-jsx-string"
  | "any-type"
  | "features-folder"
  | "card-pressable-no-testid";

export interface DesignAuditIssue {
  kind: DesignAuditIssueKind;
  file?: string;
  line?: number;
  snippet: string;
}

const PLACEHOLDER_RE =
  /tap to explore|lorem ipsum|coming soon|your content here|welcome to your app|placeholder|tap here|get started today/i;

const EMOJI_RE = /\p{Extended_Pictographic}/u;

const AUDIT_FILES = /^(App\.tsx|src\/(screens|components|lib|theme)\/.+\.(tsx|ts))$/;

/** Long literal copy inside Text — should live in data for tap-to-edit. */
const HARDCODED_TEXT_RE =
  /<Text[^>]*>\s*['"]?([A-Za-z][A-Za-z0-9\s,'—–-]{10,})['"]?\s*<\/Text>/;

const ALLOWED_LITERALS = new Set([
  "Save",
  "Cancel",
  "Delete",
  "Sign in",
  "Sign out",
  "Continue",
  "Back",
  "Settings",
  "Profile",
  "Loading...",
  "Retry",
]);

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

export async function auditDesignQuality(
  projectId: string,
  spec: AppSpec,
): Promise<DesignAuditIssue[]> {
  const issues: DesignAuditIssue[] = [];
  let files: string[];
  try {
    files = await listProjectFiles(projectId);
  } catch {
    return [{ kind: "missing-auth-module", snippet: "Could not read project files." }];
  }

  const normalized = files.map((f) => f.replace(/\\/g, "/"));
  const appCode = normalized.filter((f) => AUDIT_FILES.test(f));

  if (normalized.some((f) => f.startsWith("src/features/"))) {
    issues.push({
      kind: "features-folder",
      snippet: "src/features/ detected — use src/screens/, src/components/, src/lib/ only.",
    });
  }

  let allSource = "";

  for (const file of appCode) {
    let content: string;
    try {
      content = await readProjectFile(projectId, file);
    } catch {
      continue;
    }
    allSource += content + "\n";

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (PLACEHOLDER_RE.test(line)) {
        issues.push({
          kind: "placeholder-copy",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
      if (
        EMOJI_RE.test(line) &&
        /<Text\b|tabBarIcon|Icon|Pressable|TouchableOpacity|Button/i.test(line) &&
        !/\/\/|description|title.*recipe/i.test(line)
      ) {
        issues.push({
          kind: "emoji-as-icon",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
      if (/\b: any\b|\bas any\b|@ts-ignore/.test(line)) {
        issues.push({
          kind: "any-type",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
      if (
        /<Pressable\b[^>]*style=[^>]*background/i.test(line) &&
        !/testID=/.test(line)
      ) {
        issues.push({
          kind: "card-pressable-no-testid",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
    }

    let m: RegExpExecArray | null;
    const hardcodedRe = new RegExp(HARDCODED_TEXT_RE.source, "g");
    while ((m = hardcodedRe.exec(content)) !== null) {
      const literal = m[1]?.trim() ?? "";
      if (/\{/.test(m[0]!)) continue;
      if (ALLOWED_LITERALS.has(literal)) continue;
      issues.push({
        kind: "hardcoded-jsx-string",
        file,
        line: lineAt(content, m.index),
        snippet: literal.slice(0, 80),
      });
    }
  }

  if (!normalized.includes("src/lib/auth.ts")) {
    issues.push({
      kind: "missing-auth-module",
      snippet: "src/lib/auth.ts missing — implement sign in/out/delete account.",
    });
  }

  if (!normalized.includes("src/lib/storage.ts")) {
    issues.push({
      kind: "missing-storage-module",
      snippet: "src/lib/storage.ts missing — seed data + AsyncStorage helpers.",
    });
  }

  if (!normalized.includes("src/theme/tokens.ts")) {
    issues.push({
      kind: "missing-theme-tokens",
      snippet: "src/theme/tokens.ts missing — use Appable design tokens.",
    });
  }

  const hasBase =
    normalized.some((f) => f.includes("src/components/AppButton")) ||
    /export function AppButton|function AppButton/.test(allSource);
  const hasScreen =
    normalized.some((f) => f.includes("src/components/Screen")) ||
    /export function Screen|function Screen/.test(allSource);
  if (!hasBase || !hasScreen) {
    issues.push({
      kind: "missing-base-components",
      snippet: "Missing Screen/AppButton base components in src/components/.",
    });
  }

  if (!/useFonts|Font\.loadAsync|loadAsync\(/.test(allSource)) {
    issues.push({
      kind: "missing-font-load",
      snippet: "No expo-font loading detected — load DM Sans / display font in App.tsx.",
    });
  }

  const low = allSource.toLowerCase();
  if (!/sign[\s-]?in|signin|log[\s-]?in|authscreen|auth-screen/.test(low)) {
    issues.push({ kind: "missing-sign-in", snippet: "No sign-in screen or flow detected." });
  }
  if (!/sign[\s-]?out|signout|log[\s-]?out/.test(low)) {
    issues.push({ kind: "missing-sign-out", snippet: "No sign-out control in settings/profile." });
  }
  if (!/delete[\s-]?account|deleteaccount|remove account/.test(low)) {
    issues.push({
      kind: "missing-delete-account",
      snippet: "No delete-account flow in settings/profile.",
    });
  }

  const roles = spec.audienceRoles?.filter(Boolean) ?? [];
  if (roles.length >= 2) {
    const hasPicker =
      /role[\s-]?picker|choose.*role|select.*role|audienceRole/i.test(low) ||
      roles.every((r) => low.includes(r.toLowerCase().slice(0, 8)));
    if (!hasPicker) {
      issues.push({
        kind: "missing-role-picker",
        snippet: `Two-sided app needs role picker for: ${roles.join(", ")}`,
      });
    }
  }

  return issues;
}

export function formatDesignAuditReport(issues: DesignAuditIssue[], max = 30): string {
  if (issues.length === 0) return "No design audit issues.";
  const lines = issues.slice(0, max).map((i) => {
    const loc = i.file ? `${i.file}${i.line ? `:${i.line}` : ""}` : "project";
    return `- [${i.kind}] ${loc}: ${i.snippet}`;
  });
  if (issues.length > max) lines.push(`... and ${issues.length - max} more`);
  return lines.join("\n");
}

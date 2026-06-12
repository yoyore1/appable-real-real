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
  | "card-pressable-no-testid"
  | "too-many-tabs"
  | "sparse-seed-data"
  | "hardcoded-progress-width"
  | "material-ripple"
  | "material-elevation"
  | "material-fab"
  | "material-icon"
  | "all-caps-button"
  | "platform-color-web-unsafe";

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
      if (/TouchableNativeFeedback/.test(line)) {
        issues.push({
          kind: "material-ripple",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
      if (/\belevation:\s*\d+/.test(line)) {
        issues.push({
          kind: "material-elevation",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
      if (/floatingActionButton|FAB\b|fab\s*:/i.test(line)) {
        issues.push({
          kind: "material-fab",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
      if (/MaterialIcons|MaterialCommunityIcons|@material-icons/.test(line)) {
        issues.push({
          kind: "material-icon",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
      if (
        /<AppButton[^>]*label=["'][A-Z\s]{4,}["']/i.test(line) ||
        (/label:\s*["'][A-Z\s]{4,}["']/.test(line) && /AppButton|button/i.test(line))
      ) {
        issues.push({
          kind: "all-caps-button",
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
    // System font default — optional expo-font for hero display only
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

  // Slop prevention Cause 2: tab count budget
  const tabScreenCount = (allSource.match(/\bTab\.Screen\b/g) ?? []).length;
  const tabsArrayMatch = allSource.match(/\btabs\s*=\s*\[([\s\S]*?)\]/);
  let tabCount = tabScreenCount;
  if (tabsArrayMatch?.[1]) {
    tabCount = Math.max(tabCount, (tabsArrayMatch[1].match(/\{/g) ?? []).length);
  }
  if (tabCount > 5) {
    issues.push({
      kind: "too-many-tabs",
      snippet: `Bottom tab count ~${tabCount} — max 5 (prefer 4). Move Settings off the bar.`,
    });
  }

  // Slop prevention Cause 2: seed data density
  const storagePath = normalized.find((f) => f === "src/lib/storage.ts");
  if (storagePath) {
    try {
      const storageContent = await readProjectFile(projectId, storagePath);
      const arrayBlocks = storageContent.match(/\[[\s\S]*?\]/g) ?? [];
      const seedCounts = arrayBlocks
        .map((block) => (block.match(/\{/g) ?? []).length)
        .filter((n) => n >= 2);
      const maxSeed = seedCounts.length ? Math.max(...seedCounts) : 0;
      if (maxSeed > 0 && maxSeed < 8) {
        issues.push({
          kind: "sparse-seed-data",
          file: storagePath,
          snippet: `Seed array has ~${maxSeed} records — need 8–15 varied items for lived-in demo.`,
        });
      }
    } catch {
      /* ignore read errors */
    }
  }

  // Slop prevention Cause 3: hardcoded progress widths
  for (const file of appCode) {
    let content: string;
    try {
      content = await readProjectFile(projectId, file);
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (
        /width:\s*['"]?\d+%['"]?/.test(line) &&
        /progress|bar|fill|meter/i.test(content.slice(Math.max(0, content.indexOf(line) - 200), content.indexOf(line) + 200))
      ) {
        issues.push({
          kind: "hardcoded-progress-width",
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }

  // Web preview runs platform=web — PlatformColor() crashes unless guarded by Platform.OS === "ios"
  for (const file of appCode) {
    let content: string;
    try {
      content = await readProjectFile(projectId, file);
    } catch {
      continue;
    }
    if (!/PlatformColor\s*\(/.test(content)) continue;
    if (/Platform\.OS\s*===\s*["']ios["']/.test(content)) continue;
    issues.push({
      kind: "platform-color-web-unsafe",
      file,
      snippet:
        "PlatformColor() used without Platform.OS === 'ios' guard — breaks in-browser phone preview.",
    });
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

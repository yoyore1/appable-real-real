import type { AppSpec } from "@appable/shared";
import { iosFeelPrompt } from "./iosFeel.js";
import { slopPreventionPrompt } from "./slopPrevention.js";

/**
 * Code discipline v2 — frontier-model method on Appable's live stack.
 * Tamagui/Zustand/Expo Router/FlashList are v2 platform targets, NOT used now.
 * Slop prevention (apps/api/docs/slop-prevention.md) is merged into build prompts.
 */

export const BUILD_SEQUENCE = `## RULE 0 — THE SEQUENCE (never skip, never reorder)
Work in this exact order. UI-first generation is FORBIDDEN.
1. Data & state design (entities, state shape, mutations, seed data in src/lib/)
2. Primitives on OUR system (src/theme/tokens.ts + src/components/ base set)
3. Screens (assembled from primitives, projecting real state)
4. Interactions (every action wired, all four states handled)
5. Light motion pass (press feedback + simple entrance — no new animation deps)
6. Self-review (Rule 7 checklist below) — fix everything before BUILD COMPLETE
7. Automated gates run after you finish: design polish (Rule 7) then tap-to-edit hygiene (Rule 7b)`;

export const DATA_STATE_RULES = `## RULE 1 — DATA & STATE FIRST
Before any screen:
- Define ENTITIES as TypeScript types with realistic fields.
- Define every MUTATION as a named, typed function in src/lib/.
- State layer = AsyncStorage + typed seed data (src/lib/storage.ts). Zustand NOT used now.
- Seed 8–15 realistic, varied, app-specific records — app feels lived-in on first open.
- ALL user-visible strings live in DATA (storage.ts, tabs arrays) — UI renders {item.title},
  never hardcoded JSX literals. Renames must flow through data for tap-to-edit.
- TypeScript strict. No \`any\`. No untyped props.`;

export const PRIMITIVES_RULES = `## RULE 2 — PRIMITIVES BEFORE SCREENS
Before screens, use iOS template components in src/components/ + tokens.ts:
- Screen, Card, AppButton, Row, EmptyState, GroupedSection, SettingsRow,
  SegmentedControl, SearchField, Sheet, AppAlert, ActionMenu, AppIcon, Blur.
- Editable primitives (tap-to-edit by architecture): EditableText, EditableIcon,
  EditableBackground. These are required for every user-visible element.
- System font for ALL functional UI (rows, labels, buttons, tabs). Display font
  only on hero headings if spec.vibe calls for it — never on tab labels or rows.
- Call applyBrandPrimary(spec.vibe.primaryColor) in tokens.ts on first build.
- Token values from src/theme/tokens.ts only — PlatformColor semantics on iOS.
- ONLY use dependencies already in the golden template. Do NOT npm install.
- Every primitive MUST accept label + testID props and pass testID to inner Text.
  SettingsRow: testID on row, label, value, chevron. Never hide labels in wrappers.`;

export const FILE_LAYOUT_RULES = `## RULE 3 — FILE LAYOUT
- Tab bar = TWO routes ONLY: app/(tabs)/index.tsx (Home) and app/(tabs)/settings.tsx.
- ALL other screens go in app/(stack)/ — e.g. app/(stack)/habits.tsx, app/(stack)/streak/[id].tsx.
  Navigate with router.push('/habits') or router.push(\`/streak/\${id}\`). Never add tab-bar routes.
- Code also in: src/components/, src/lib/, src/theme/.
- Do NOT edit app/_layout.tsx, app/(tabs)/_layout.tsx, or app/(stack)/_layout.tsx — platform-owned.
- Relative imports to src/: \`../../src/...\` from \`app/(tabs)/*.tsx\` or \`app/(stack)/*.tsx\`;
  \`../../../src/...\` from one nested folder (e.g. \`app/(stack)/streak/[id].tsx\`).
- Do NOT use /features/ or other folder conventions.
- Keep files focused; do NOT split aggressively if splitting would create split Text nodes
  or missing testIDs. Edit-contract integrity beats line-count purity.`;

export const FOUR_STATES_RULES = `## RULE 4 — EVERY INTERACTION, ALL FOUR STATES
For every user action and async operation handle:
- Loading — visible feedback (never frozen UI)
- Error — friendly message + retry ("Hit a snag — try again?")
- Empty — designed empty state (vector icon + warm line + action), never blank
- Success — state updates visibly + feedback where meaningful
Happy-path-only code is slop.`;

export const MOTION_RULES = `## RULE 5 — MOTION (light, systematic)
- Press feedback on AppButton/Pressable (opacity or subtle scale) — defined once, inherited.
- Simple fade-in on screen mount if easy with existing APIs — no new animation libraries.
- Restraint over sprinkles. One motion language, not per-screen one-offs.`;

export const WIRING_AND_EDIT_RULES = `## RULE 6 — WIRING HONESTY + EDIT CONTRACT (editable-by-architecture)
- Every interactive element does something real. ZERO dead taps.
- Lists render from real store data — never hardcoded JSX rows.
- Device features (camera, notifications, etc.) use real expo modules when in spec — no mock Alert("would open").
- Card/row Pressable wrappers that users tap for BACKGROUND color edits must be wrapped in <EditableBackground>.

Editable-by-architecture contract (binding):
- Every customer-visible text uses <EditableText> with a stable testID and a source pointing to UI_STRINGS or storage data.
- Every vector icon uses <EditableIcon> with a stable testID and a source pointing to tokens.colors.
- Every card, header, row, or container whose background color should be editable uses <EditableBackground> with a source pointing to tokens.colors.
- Source-of-truth files: src/lib/strings.ts (UI_STRINGS), src/theme/tokens.ts (colors), src/lib/storage.ts (user data arrays).
- Icons: @expo/vector-icons ONLY via EditableIcon, in SIBLING nodes — never emoji as UI icons.
- .map() rows: stable testIDs on the EditableBackground row AND inner EditableText nodes.
- Renames through data, not JSX literals. NEVER hardcode user-visible strings in JSX.
- Inline style overrides on specific Text nodes are FORBIDDEN for tap-to-edit edits — use the EditableText defaultValue and the override store instead.`;

export const SELF_REVIEW_RULES = `## RULE 7 — SELF-REVIEW (before BUILD COMPLETE)
Re-read every screen and fix before finishing:
- [ ] Dead/unwired interactive elements?
- [ ] Missing loading/error/empty/success on actions?
- [ ] Improvised token values (off tokens.ts)?
- [ ] any types or untyped props?
- [ ] Hardcoded user-visible strings in JSX (should be in data)?
- [ ] Hardcoded list rows instead of store-driven .map()?
- [ ] Placeholder or generic sample data?
- [ ] New dependency outside golden template?
- [ ] Emoji used as icons?
- [ ] One dominant CTA per screen; primary color ≤ ~30% of elements?
- [ ] Tab bar ≤ 5 tabs; labels don't clip at ~375px width?
- [ ] Progress/chart visuals match underlying data (no hardcoded bar widths)?
- [ ] Label+value rows survive 20-char names (label flex:1 + ellipsize)?
- [ ] Lists work at 0 items (empty state) and many items (scroll)?
- [ ] iOS feel: no Material tells, 17pt body, grouped lists, AppAlert/ActionMenu wrappers?
- [ ] Every customer-visible text is <EditableText> with testID + source?
- [ ] Every vector icon is <EditableIcon> with testID + source?
- [ ] Every editable-background container is <EditableBackground> with testID + source?
- [ ] No raw <Text>, no raw <Ionicons>, no raw color literals in generated screens?

FINAL BAR: boring consistent codebase + normie believes it's App Store ready +
every visible label/card is tappable and editable by architecture.`;

export const TAP_HYGIENE_GATE = `## RULE 7b — TAP-TO-EDIT GATE (automated, runs after you finish)
An automated hygiene pass runs after build and every edit. Pretty but untappable = FAILED.
See rule 7b in hard rules for full contract.`;

export function codeDisciplinePrompt(spec: AppSpec): string {
  return [
    slopPreventionPrompt(),
    iosFeelPrompt(),
    BUILD_SEQUENCE,
    DATA_STATE_RULES,
    PRIMITIVES_RULES,
    FILE_LAYOUT_RULES,
    FOUR_STATES_RULES,
    MOTION_RULES,
    WIRING_AND_EDIT_RULES,
    appNonNegotiables(spec),
    SELF_REVIEW_RULES,
    TAP_HYGIENE_GATE,
  ].join("\n\n");
}

/** Platform non-negotiables — auth + role picker. */
export function appNonNegotiables(spec: AppSpec): string {
  const roles = spec.audienceRoles?.filter(Boolean) ?? [];
  const roleBlock =
    roles.length >= 2
      ? `
### Role picker (two-sided app)
audienceRoles: ${JSON.stringify(roles)}
- BEFORE main app: dedicated role-picker screen with large tappable cards per role.
- Persist role in src/lib/auth.ts session. testID: role-picker-\${slug}, role-picker-\${slug}-label.`
      : `- Single audience — no role picker unless audienceRoles has 2+ entries.`;

  return `### Non-negotiable app features
1. Sign in (src/lib/auth.ts) — testID: auth-sign-in, auth-email, auth-name
2. Sign out in Settings — testID: settings-sign-out
3. Delete account in Settings (confirm, wipe data) — testID: settings-delete-account
4. Root route gates auth: !session → auth flow, else main tabs
${roleBlock}`;
}

/** Shorter anti-slop rules for design polish agent. */
export const DESIGN_QUALITY_RULES = `### Visual quality (iOS native + tokens)
- iOS grouped background, system font on functional UI, 17pt body, 34pt large titles.
- spec.vibe.primaryColor as tint/CTA via applyBrandPrimary — not Appable platform colors.
- Primary color on ≤ ~30% of elements per screen; big stats = label color.
- ONE dominant CTA per screen; max 5 bottom tabs (prefer 4).
- GroupedSection + SettingsRow for lists; no elevation shadows; Ionicons/AppIcon only.
- Seed 8–15 varied records; progress bars 30–70% filled. Zero dead buttons.`;

export function designPolishUserMessage(report: string): string {
  return [
    "Rule 7 design audit found gaps. Fix EVERY item.",
    "Apply slop prevention + iOS native feel: grouped lists, system font, no Material tells.",
    "Use tokens.ts, auth.ts, base components, data-driven strings.",
    "",
    report,
  ].join("\n");
}

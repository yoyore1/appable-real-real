/**
 * Slop prevention — agent-facing rules from apps/api/docs/slop-prevention.md.
 * Injected into build, edit, heal, and design-polish prompts.
 */

export const SLOP_CORE = `## SLOP PREVENTION (binding)
Slop = freedom the model should not have. Fix class permanently:
**Template what repeats. Cap what needs taste. Derive what must agree. Simulate what must be seen.**
Hierarchy when rules conflict: **edit contract > numeric budgets > soft guidance.**`;

export const TEMPLATE_NOT_GENERATED = `### Cause 1 — Template owns setup (do NOT regenerate)
Golden template already provides: iOS tokens (PlatformColor behind Platform.OS === "ios" only — never bare PlatformColor or web preview breaks),
base components (Screen, GroupedSection, SettingsRow, AppButton, Sheet, AppAlert, etc.),
bridge + index import, App.tsx state navigation shell. Metro/babel/bridge are platform-owned.
Generate ONLY app-specific: entities, seed data, screens, interactions, motion.
If two apps would need identical code, it belongs in template — not your build.`;

export const NUMERIC_BUDGETS = `### Cause 2 — Numeric budgets (not taste)
- Max 5 bottom tabs (prefer 4). Settings is never a tab when the bar is full.
- Primary brand color on ≤ ~30% of elements per screen (CTAs, active tab, progress fill,
  success moments ONLY). Big stat numbers = ink/charcoal, not primary.
- 3 typographic levels minimum per screen (title / body / meta).
- ONE **dominant** CTA per screen = one solid primary-color button. Secondary/text/icon
  actions are fine — budget is visual dominance, not total button count.
- File length ~150 lines = soft guidance. **Edit contract wins:** never split files if
  it breaks testIDs, splits Text nodes, or moves labels out of patcher reach.
- Seed data: 8–15 varied records; progress bars 30–70% filled (visible, not empty/full).`;

export const DERIVE_SINGLE_TRUTH = `### Cause 3 — Derive, never restate
Define each fact ONCE in src/lib/storage.ts or tokens.ts; every screen reads it.
Progress bars: width from saved/target data — never hardcoded percentages.
Same metric on two screens = same store field. Duplicated JSX literals = forbidden.`;

export const ADVERSARIAL_SIMULATION = `### Cause 4 — Adversarial simulation (Rule 7 mental checks — NO vision gate at launch)
Before BUILD COMPLETE, stress-test by reasoning (not screenshots):
- [ ] Label+value rows with 20-char names: overlap? (label flex:1 + numberOfLines={1} +
  ellipsizeMode="tail"; value intrinsic width; no absolute positioning on either)
- [ ] Every list at 0 items: designed empty state? At 100 items: scroll still works?
- [ ] Every progress/chart matches underlying data — visual never contradicts numbers
- [ ] Tab bar: labels clip? More than 5 tabs?
- [ ] Every screen at narrow phone width (~375): text cut off? buttons unreachable?`;

/** Compact rules for edit/heal agents — preserve slop prevention without full rebuild. */
export const SLOP_EDIT_RULES = `### Slop prevention (edits too)
- Do not undo template setup (fonts, tokens, auth, base components, bridge).
- Keep strings in data (storage.ts), colors in tokens.ts — do not hardcode in JSX.
- One dominant primary CTA per screen you touch; primary color ≤ ~30% of elements there.
- Preserve testIDs and data-driven labels — edit contract beats aesthetics.
- No new deps, no Expo Router, no /features/, no emoji icons.`;

/** Full slop block for initial builds and design polish. */
export function slopPreventionPrompt(): string {
  return [
    SLOP_CORE,
    TEMPLATE_NOT_GENERATED,
    NUMERIC_BUDGETS,
    DERIVE_SINGLE_TRUTH,
    ADVERSARIAL_SIMULATION,
  ].join("\n\n");
}

/** Shorter block for surgical edits. */
export function slopPreventionEditPrompt(): string {
  return [SLOP_CORE, SLOP_EDIT_RULES].join("\n\n");
}

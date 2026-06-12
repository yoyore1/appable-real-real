/**
 * iOS native feel — agent-facing rules from apps/api/docs/ios-native-feel.md (Layer 1).
 * Injected into build, edit, heal, and design-polish prompts.
 */

export const IOS_CORE = `## iOS NATIVE FEEL (Layer 1 — binding)
Every app must read as premium native iOS, never Android/Material/cross-platform JS.
Structure = iOS HIG. Identity = customer spec (spec.vibe.primaryColor in tokens.ts).
Use template components — never raw ActionSheetIOS/Alert/BlurView in app code.`;

export const IOS_BANS = `### Hard bans (Android-isms)
- NO TouchableNativeFeedback, ripple, FAB, drawer/hamburger, top Material tabs
- NO elevation/heavy shadows — grouped background contrast + hairline separators
- NO Material icons — Ionicons (iOS-style) or AppIcon (SF Symbol fallback)
- NO toasts/snackbars — inline state, AppAlert, or subtle banners
- NO ALL-CAPS button labels — sentence case, 17pt semibold
- NO outlined/floating-label TextInputs — rounded grey fill or SettingsRow`;

export const IOS_TYPE = `### Typography (functional UI = system font)
- System font for rows, labels, buttons, tabs, inputs (NOT display font)
- Apple scale: largeTitle 34 bold, title 28/22 bold, headline 17 semibold,
  body 17 regular, subhead 15, footnote 13, caption 12
- Weights: regular / semibold / bold only — not medium everywhere
- Semantic text colors from tokens.ts (PlatformColor on iOS, web fallbacks)`;

export const IOS_COMPONENTS = `### Use template components (do not reinvent)
- GroupedSection + SettingsRow for Settings-style lists (44pt rows, inset separators, chevrons)
- SegmentedControl for view switching — NOT top tabs
- SearchField for search — NOT Material search
- Sheet for modals (pageSheet) — NOT full-screen overlays
- AppAlert / ActionMenu for confirms & option lists — NOT custom Material dialogs
- AppButton (primary filled 50pt, secondary text/tint, destructive red text)
- Screen (grouped bg, iOS ScrollView props), Card (no elevation shadow)
- expo-haptics via src/lib/haptics.ts on meaningful taps
- @react-native-community/datetimepicker for dates — never custom calendar UI`;

export const IOS_RULE7 = `### Rule 7 — iOS self-review
- [ ] Any Material tell? (ripple, FAB, elevation, top tabs, drawer, outlined inputs)
- [ ] Body 17pt? Large titles 34pt bold? System font on functional UI?
- [ ] Settings-style grouped lists with inset separators + chevrons?
- [ ] AppAlert / ActionMenu (not raw Alert/ActionSheet in screens)?
- [ ] Haptics on toggles/buttons/completions?
- [ ] 44pt touch targets, 16pt margins, safe areas?
- [ ] spec.vibe.primaryColor applied in tokens.ts?
- [ ] Would an iPhone user believe this came from Xcode?`;

/** Full iOS feel block for builds and design polish. */
export function iosFeelPrompt(): string {
  return [IOS_CORE, IOS_BANS, IOS_TYPE, IOS_COMPONENTS, IOS_RULE7].join("\n\n");
}

/** Compact block for edits/heals — preserve iOS feel without full rebuild guidance. */
export const IOS_EDIT_RULES = `### iOS feel (edits too)
- Keep using template components; no Material patterns or new deps
- System font + tokens.ts colors; apply spec primary if changing brand color
- Preserve testIDs on SettingsRow labels/values and grouped list rows
- AppAlert/ActionMenu only — no raw ActionSheetIOS in screen files`;

export function iosFeelEditPrompt(): string {
  return [IOS_CORE, IOS_EDIT_RULES].join("\n\n");
}

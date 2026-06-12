# APPABLE — iOS-NATIVE FEEL SPEC (make RN apps look/feel like premium native iOS, never Android)

Goal: every generated app should be indistinguishable from a native iOS app built by an Apple-platform designer. The enemy is the "slightly off platform feel" — JavaScript-looking tab bars, Material Design tells, generic cross-platform styling. This spec has two layers: **Layer 1 applies NOW** (works in the current golden template: StyleSheet, App.tsx state nav, no new deps). **Layer 2 is the v2 platform target** (native primitives — parked with the already-scheduled v2 migration).

---

# LAYER 1 — iOS FEEL IN THE CURRENT TEMPLATE (apply to every build now)

## 1. TYPOGRAPHY (the biggest single tell)
- iOS system font = SF Pro, and RN gives it automatically: `fontFamily: 'System'` on iOS. The brand display font (per design system) is for hero moments/headings; ALL functional UI text (rows, labels, buttons, tab labels) uses the system font so it reads as iOS.
- Use Apple's type scale, not arbitrary sizes:
  - Large title: 34pt bold (screen headers)
  - Title: 28pt bold / 22pt bold
  - Headline: 17pt semibold
  - Body: 17pt regular (NOT 14/16 — 17 is the iOS body size)
  - Subhead: 15pt; Footnote: 13pt; Caption: 12pt
- Weights: iOS uses regular/semibold/bold. Avoid medium-everywhere (a Material habit).
- Letter-spacing: iOS is slightly tight on large titles; never add wide tracking (Android/Material habit).
- Text colors: pure-ish black `#000`/near-black for primary, `rgba(60,60,67,0.6)` style secondary (iOS secondary label), tertiary even lighter. Never Material grey-700-style palettes.

## 2. KILL EVERY ANDROID-ISM (hard bans)
- ❌ NO Material ripple effects (never TouchableNativeFeedback). Press feedback = opacity fade (activeOpacity ~0.6) or subtle scale — the iOS press feel.
- ❌ NO FABs (floating action buttons) — Android pattern. iOS puts add-actions in the nav bar (+ top right) or as a primary button in content.
- ❌ NO Material elevation/heavy drop shadows. iOS shadows are extremely subtle and diffuse (low opacity, large radius) or absent — separation comes from background-color contrast (grouped backgrounds), not shadow.
- ❌ NO top tab bars / swipeable Material tabs. iOS uses segmented controls or bottom tabs.
- ❌ NO hamburger menus / drawers. Bottom tabs + stacks only.
- ❌ NO Material icons (the filled geometric Google look). Use Ionicons from @expo/vector-icons (iOS-style line icons mirroring SF Symbols) — chevron-forward, ellipsis-horizontal, square-and-arrow-up share style, etc.
- ❌ NO Android-style toasts/snackbars. iOS communicates via inline state changes, alerts, or subtle banners.
- ❌ NO centered ALL-CAPS button labels (Material habit). iOS buttons: sentence case, 17pt, semibold.

## 3. iOS COMPONENT PATTERNS (build these in StyleSheet)
- **Inset grouped lists (the Settings look):** rounded-rect grouped sections (10-12pt radius) on a grouped background (#F2F2F7 light), rows 44pt+ min height, separators inset from the left (aligned with text, not full-bleed), chevron-right disclosure on navigable rows, value text in secondary color on the right.
- **Switches:** iOS toggle look — green (#34C759) on-state. RN's Switch renders native on iOS already; never restyle it Material.
- **Segmented controls:** the iOS pill-in-track look for view switching (greyed track, white sliding segment, subtle shadow).
- **Buttons:** primary = filled rounded-rect (12-14pt radius, 50pt height, 17pt semibold); secondary = tinted text-only button (iOS loves text buttons); destructive = red text.
- **Navigation header:** iOS pattern — large title (34pt bold) that the screen owns, back affordance as chevron + previous screen title, actions as text buttons or icons top-right.
- **Search:** iOS search bar look — rounded grey field (#E9E9EB), magnifying glass icon left, "Cancel" text button appears on focus.
- **Modals/sheets:** slide-up sheet with grabber handle (36×5pt rounded bar top-center), rounded top corners (10pt+), pageSheet presentation feel. Prefer sheets over full-screen takeovers.
- **Alerts/confirmations:** use the NATIVE Alert API (Alert.alert) — never custom Material dialogs. Destructive actions use the destructive style.
- **Action menus:** ActionSheetIOS for option lists (native iOS action sheet).
- **Pull-to-refresh:** RefreshControl (renders the native iOS spinner).
- **Empty/loading:** iOS-style subtle spinners (ActivityIndicator), skeletons with soft shimmer; never Material circular progress styling.

## 4. COLOR & SURFACE CONVENTIONS
- Backgrounds: iOS grouped background (#F2F2F7) behind white (#FFFFFF) cards/sections in light mode; true layered darks (#000 base, #1C1C1E elevated) in dark mode.
- iOS system palette as reference for semantic colors: blue #007AFF, green #34C759, red #FF3B30, orange #FF9500 — the app's brand primary replaces blue, but semantic colors stay iOS-true.
- Translucency: iOS loves frosted/translucent surfaces (nav areas, tab areas, overlays). Simulate with high-opacity whites/blurs where the template allows.
- Separators: hairline (StyleSheet.hairlineWidth), iOS separator color rgba(60,60,67,0.29) — never 1-2px solid grey lines.

## 5. SPACING, SHAPE, LAYOUT
- 16pt standard horizontal margins (iOS default content inset). Generous vertical rhythm.
- Corner radii: cards/sections 10-14pt, buttons 12-14pt, sheets 10pt+ top. Consistent across the app (from tokens).
- Touch targets: 44pt minimum (Apple HIG).
- Safe areas respected everywhere (notch, home indicator).
- Tab bar: bottom, translucent feel, icons + 10pt labels, active tint = app primary, inactive = iOS grey.

## 6. MOTION & FEEL
- Haptics (expo-haptics — already in the Expo SDK): selection feedback on toggles/pickers, impactLight on button presses, notificationSuccess on completions. iOS apps FEEL like iOS through haptics as much as visuals.
- Springy, soft animations (the existing entrance pattern) — iOS motion is fluid and physical, never linear/abrupt.
- Press states: opacity/scale, instant response.
- Swipe-to-delete on list rows where deletion exists (iOS list convention).
- Keyboard: KeyboardAvoidingView handled properly, inputs never hidden — janky keyboard handling screams non-native.

## 7. PLATFORM-CORRECT DETAILS
- Date/time: iOS-style pickers (native picker components), never Material calendar dialogs.
- Status bar: correct style per screen background (dark content on light).
- Text inputs: iOS look — minimal, rounded grey fill (#E9E9EB style) or inset-grouped rows, NEVER Material outlined/floating-label fields.
- Share actions: native Share API (the iOS share sheet).
- App icon + splash: follow iOS conventions (the template/publish pipeline owns this).

## 8. RULE 7 ADDITIONS (self-review checks for iOS feel)
- [ ] Any Material tell present? (ripple, FAB, elevation shadow, top tabs, drawer, outlined inputs, ALL-CAPS buttons, Material icons)
- [ ] Body text at 17pt? Large titles 34pt bold? System font for functional UI?
- [ ] Lists inset-grouped with inset separators + chevrons where navigable?
- [ ] Alerts via native Alert API? Action lists via ActionSheetIOS?
- [ ] Haptics on meaningful interactions?
- [ ] 44pt touch targets? 16pt margins? Safe areas respected?
- [ ] Would an iPhone user believe this came from Xcode?

---

# LAYER 2 — NATIVE PRIMITIVES (v2 platform target — parked, do not implement now)

These deliver the final 10% (true system rendering) and align with the scheduled v2 golden-image migration. They are the 2026 state of the art:

- **NativeTabs (Expo Router SDK 54+, alpha):** delegates the tab bar to the OS — real UITabBarController. On iOS 26 this renders the Liquid Glass design automatically; on older iOS the classic system bar; Material 3 on Android. Kills the "JavaScript tab bar" tell entirely, and future iOS redesigns come free.
- **Native stack navigation:** real UINavigationController — true large-title behavior (collapses on scroll), edge swipe-back, native transition physics.
- **SF Symbols (expo-symbols):** Apple's actual icon system (with weights/scales/hierarchical color) replacing Ionicons.
- **Native context menus** (long-press UIMenu with SF Symbols) for power interactions.
- **Liquid Glass surfaces** (iOS 26 design language) on bars/overlays via the native modifiers Expo SDK 54 exposes; requires Xcode 26 builds (EAS default for SDK 54).
- **Form sheets with detents** (native partial-height sheets).

Strategic note: iOS 26's Liquid Glass broke every framework that FAKES Apple's UI (Flutter-style emulation). React Native renders real native components, so adopting native primitives means Apple's future design changes arrive automatically. The closer generation sticks to system primitives, the more future-proof and premium every app becomes — this is a durable edge over builders that ship lookalike JS UI.

---

# MERGE RESOLUTIONS (binding — resolves the integration tensions)

## R1 — Brand vs iOS chrome: the explicit split
**Structure & functional UI = iOS. Identity = customer spec (not Appable platform brand).** Precisely:
- **iOS-owned (system conventions, always):** type scale (17pt body, 34pt large title), system font for all functional text (rows, labels, buttons, tab labels, inputs), grouped-list structure, 44pt rows, inset hairline separators, chevrons, PlatformColor semantics, native alerts/sheets/pickers via template wrappers, NO elevation shadows.
- **Spec-owned (per app):** `spec.vibe.primaryColor` via `applyBrandPrimary()` in tokens.ts. Optional display font on hero headings ONLY if the spec calls for it — never on tab labels, rows, or buttons.
- **Template defaults:** neutral iOS grouped background (#F2F2F7 / PlatformColor) — NOT Appable builder branding. Cards grouped-style with hairline separators.

## R2 — Web preview compatibility (the customer's first look)
- The agent NEVER calls iOS-only APIs raw (ActionSheetIOS, Alert.prompt, raw BlurView). It uses TEMPLATE COMPONENTS that branch per platform: `ActionMenu` (ActionSheetIOS on iOS → iOS-styled bottom sheet on web), `AppAlert` (native Alert on iOS → iOS-styled modal on web), `Blur` wrapper (BlurView on iOS → translucent fallback on web).
- tokens.ts wraps PlatformColor with web fallback values so semantic colors render correctly everywhere.
- expo-haptics no-ops on web — fine, call freely.
- Rule: the web preview must LOOK iOS via tokens/styling even where native APIs don't exist.

## R3 — Spec size vs agent reliability: bake, don't remind
- Full doc lives in the repo (apps/api/docs/ios-native-feel.md) as reference.
- Build prompts get a CONDENSED `iosFeelPrompt()` (~40 lines): the ban list, the type scale, 5 component rules, the Rule 7 iOS checklist.
- Everything bakeable is MECHANICALLY ENFORCED in the template instead of prompted: GroupedSection, SettingsRow (44pt, inset separator, chevron), SegmentedControl, SearchField, Sheet (pageSheet), ActionMenu, updated tokens.ts (Apple type scale + PlatformColor wrappers + hairline token + grouped backgrounds, elevation killed). Baking beats reminding — this is slop-prevention Cause 1 applied to iOS feel.

## R4 — Accepted corrections
- Display font scoped to hero/brand moments ONLY (functional UI = system font everywhere).
- Secondary button = iOS text/tint button, NOT a bordered button (bordered reads Material). Update AppButton.
- expo-symbols in the template WITH Ionicons fallback in the component layer (web + older paths never break).
- Swipe-to-delete: deferred until the template owns a SwipeableRow wrapper — listed as "when available," not a generation requirement.

## IMPLEMENTATION ORDER (green-lit)
1. Rewrite tokens.ts (Apple type scale, PlatformColor/DynamicColorIOS semantics, grouped backgrounds, hairline token, kill elevation)
2. New template components (GroupedSection, SettingsRow, SegmentedControl, SearchField, Sheet, ActionMenu/AppAlert wrappers)
3. Upgrade AppButton/Screen (50pt primary, 17pt semibold sentence case, Pressable opacity, iOS ScrollView props)
4. Golden template deps: expo-haptics, expo-blur, @react-native-community/datetimepicker (platform-owned; agent never installs)
5. Prompt + audit: condensed iosFeelPrompt() + Android-ism greps (TouchableNativeFeedback, `elevation:`, FAB, Material icon names, ALL-CAPS buttons)
6. Layer 2 parked; one line in build prompts only: "v2 will use native tab/stack; stay compatible."

---

# THE COMPLETE iOS API & IMPORT INVENTORY (exhaustive)

## A. ZERO-DEPENDENCY — RN CORE APIS (use in the current template TODAY, no installs)
- **PlatformColor / DynamicColorIOS** — Apple's ACTUAL system colors, auto-adapting to dark mode: `PlatformColor('label')`, `'secondaryLabel'`, `'systemBackground'`, `'secondarySystemGroupedBackground'`, `'separator'`, `'systemBlue'`, `'systemGreen'`, `'systemRed'`. Use these for ALL semantic colors (text, backgrounds, separators) — perfect iOS colors + free dark mode, no token guessing. `DynamicColorIOS({light, dark})` for brand colors that adapt.
- **LayoutAnimation** — iOS-native spring layout transitions with one line: `LayoutAnimation.configureNext(LayoutAnimation.Presets.spring)` before any state change that adds/removes/resizes elements (list inserts/deletes, expansions). The cheapest premium-motion win in the whole stack.
- **Animated (spring)** — `Animated.spring` with iOS-feel physics (friction ~8-10, tension ~40) for press scale, progress, reveals. Never linear timing for physical motion.
- **Modal `presentationStyle="pageSheet"` / `"formSheet"`** — the REAL native iOS sheet (card-stack effect, pull-to-dismiss). Use for any modal flow instead of custom overlays.
- **Alert.alert** — native alerts (incl. destructive style, text inputs via Alert.prompt).
- **ActionSheetIOS** — native action sheets for option menus.
- **Share API** — the native iOS share sheet.
- **Switch** — native iOS toggle (never restyled).
- **RefreshControl** — native iOS pull-to-refresh spinner (set tintColor).
- **ScrollView/FlatList iOS-feel props (tiny but unmistakable):**
  - `keyboardDismissMode="interactive"` — drag-to-dismiss keyboard like Messages
  - `contentInsetAdjustmentBehavior="automatic"` — correct safe-area content insets
  - `bounces={true}` (keep the iOS rubber-band; never disable)
  - `showsVerticalScrollIndicator` default; `decelerationRate="normal"`
- **KeyboardAvoidingView** (`behavior="padding"` on iOS) — inputs never hidden.
- **StyleSheet.hairlineWidth** — true hairline separators.
- **Vibration fallback** — not needed; haptics below.
- **StatusBar** — style per screen background.
- **AccessibilityInfo + Dynamic Type:** respect user font scaling; set `maxFontSizeMultiplier` (~1.3-1.5) on dense UI so scaling never breaks layouts. Accessibility labels on icon-only buttons.

## B. EXPO SDK PACKAGES (already in the SDK — golden-template additions, platform-owned)
- **expo-haptics** — selection on toggles/pickers, impactLight on presses, notificationSuccess/Error on outcomes. iOS feel is 50% touch.
- **expo-blur (BlurView)** — REAL frosted glass: tab-bar backgrounds, headers over scrolling content, overlays. `tint="systemChromeMaterial"` matches iOS chrome. This replaces "simulated translucency" — use actual blur.
- **expo-symbols (SymbolView)** — Apple's real SF Symbols with weights/scales/animations. Template-add candidate NOW (it's an Expo SDK package); falls back to Ionicons where unavailable.
- **@react-native-community/datetimepicker** (Expo-supported) — native iOS date/time wheels and inline calendar. Never custom date UI.
- **expo-local-authentication** — Face ID / Touch ID for apps with auth, privacy screens, or "unlock" moments. Deeply premium iOS signal.
- **expo-clipboard** — copy actions with haptic + "Copied" feedback.
- **expo-linear-gradient** — brand gradient moments (heroes, progress fills).
- **expo-image** — already standard for performant images.
- **expo-screen-orientation** — portrait lock (phone apps lock portrait like most premium iOS apps).
- **expo-status-bar** — declarative status bar styling.

## C. v2 / NATIVE-PRIMITIVE ADDITIONS (parked with the v2 migration)
- NativeTabs (system UITabBarController, Liquid Glass on iOS 26)
- Native stack (UINavigationController: collapsing large titles, edge swipe-back)
- Native context menus (UIMenu long-press w/ SF Symbols) — zeego / react-native-ios-context-menu
- Form sheets with detents (partial-height native sheets)
- Liquid Glass surfaces (iOS 26 modifiers, Xcode 26 builds)
- Swipeable list rows (gesture-handler Swipeable — iOS swipe-to-delete/actions) if gesture-handler enters the template
- Live Activities / Dynamic Island, Home-screen widgets (native modules — Phase 3, premium differentiators)

## TEMPLATE DIRECTIVE
Items in A are RULES for generation immediately (they're free). Items in B get baked into the golden template as platform-owned capabilities (one-time additions, then every build uses them). Items in C wait for the v2 golden-image migration. The combination of A+B alone — system colors, spring LayoutAnimation, real sheets, real blur, SF Symbols, haptics, Face ID, native pickers, the iOS scroll props — is enough to make a StyleSheet app feel indistinguishable from native to a normal iPhone user.

---

## OPERATING PRINCIPLE
When in doubt on ANY element: "What does Apple's own app do?" (Settings for lists, Health/Fitness for stats screens, App Store for cards/headers, Messages for inputs). Copy the platform, not other cross-platform apps. iOS structure + customer spec identity on top = premium native feel.

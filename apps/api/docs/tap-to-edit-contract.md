# Tap-to-Edit Contract (editable-by-architecture)

Goal: tap-to-edit works for 95%+ of user-visible copy and chrome, on any app
we generate, without code patching.

## Core idea

The build agent emits apps whose editable content is **data-driven** and whose
editable elements are **self-identifying**. The runtime tap-to-edit engine
never patches source code; it mutates a runtime override store and persists to
AsyncStorage. Edits appear in ~16ms with no bundle rebuild.

## The template layer

The template (`packages/template`) exposes three editable components and one
provider. The build agent MUST use them for every user-visible element that
could reasonably be edited by a non-technical customer.

| Component | Use for |
|-----------|---------|
| `EditableText` | Any user-visible `<Text>` (titles, labels, body, prices, dates, button text). |
| `EditableIcon` | Any `@expo/vector-icons` icon whose color might be edited. |
| `EditableBackground` | Any container whose background color should be editable (cards, headers, rows, empty states). |
| `TapEditProvider` | Wraps the app root. Must be inside `app/_layout.tsx` (platform-owned) so every screen gets it. |

Every editable component requires:

- `testID`: stable, unique string following the naming convention below.
- `source`: `{ file, export, property? }` pointing to the source-of-truth file.
- `defaultValue`: the value that would render without any override.

Example:

```tsx
<EditableText
  testID="home-title"
  source={{ file: "src/lib/strings.ts", export: "UI_STRINGS", property: "homeTitle" }}
  defaultValue={{ text: UI_STRINGS.homeTitle, color: colors.primary as string }}
/>
```

## Data layer

All user-visible strings and customer-facing style values live in typed data
files. The LLM MUST generate these files and import them from editable
components. Allowed source files:

- `src/lib/strings.ts` — typed `UI_STRINGS` object.
- `src/lib/tokens.ts` — `colors`, `spacing`, `radius`, `typography` objects
  exported by the scaffold. The build agent may add extra semantic color tokens
  (e.g. `colors.heroBackground`) but must not duplicate existing tokens.
- `src/lib/storage.ts` — user data arrays/objects loaded/saved with AsyncStorage.
  Editable list items use their `id` in the testID, not a hardcoded label.

Forbidden in generated app code:

- Hardcoded strings inside `<Text>`, `<Button>`, `Alert.alert`, or placeholder.
- Raw hex/rgb/named colors inside `StyleSheet.create` or inline styles.
- Non-editable `<Text>` without a `testID`.
- `<Ionicons>` (or other vector icons) without a `testID` and `EditableIcon` wrapper.

## testID convention

Roles determine what the tap UI can edit. Every user-facing element has ONE role.

| Role | Pattern | Editable properties |
|------|---------|---------------------|
| `text` | `<screen>-<thing>` or `<screen>-<thing>-<label>` | text, color, fontSize, fontWeight, fontFamily |
| `icon` | `<parent>-icon`, `<parent>-chevron`, `<parent>-close` | color |
| `background` | `<screen>-<thing>` (container) | backgroundColor |
| `row/card` | `<screen>-<list>-<id>-row`, `<screen>-<thing>-card` | backgroundColor (on the container); text/icon on children |
| `screen-shell` | `<screen>-screen` | none — never tappable |
| `row-wrapper` | `<screen>-<list>`, `<screen>-<section>` | none — structural only |

For `.map()` rows, the row container gets `<list>-<id>-row` and each inner
field gets `<list>-<id>-<field>`.

Examples:

- `home-title`
- `home-subtitle`
- `home-stat-total-value`
- `home-add-habit-icon`
- `home-habit-${habit.id}-row`
- `home-habit-${habit.id}-name`
- `settings-notif-row`
- `settings-notif-row-label`

## Runtime protocol

The preview exposes every registered element via `window.__appableTapEditRegistry`
(web) or the bridge (native). When a user taps an element:

1. The bridge picks the top-most registered element at the tap coordinates.
2. It sends `{ type: "chat.send", message: "Tap edit: <testID> <intent>" }` to the API.
3. The API looks up the element and calls `setOverride(testID, patch)`.
4. The element re-renders from the override store.

No source code is touched during the edit.

## Persistence model

Overrides are stored in AsyncStorage under `@appable/tap-edit-overrides`. They
survive reload but do not survive a full project reset. The user's original
source files remain unchanged. Later phases may write overrides back to source,
but v1 is runtime-only.

## Audit checklist

The build audit will reject any generated app that:

1. Imports `<Text>` from `react-native` for user-visible copy without wrapping it
   in `<EditableText>`.
2. Uses raw `<Ionicons>` instead of `<EditableIcon>`.
3. Uses a raw hex/rgb/named color in `StyleSheet.create` or inline styles.
4. Has a `<Text>` without a `testID`.
5. Has an icon without a `testID`.
6. Hardcodes user copy in JSX.
7. Does not wrap the root in `<TapEditProvider>`.
8. Does not include typed `UI_STRINGS` in `src/lib/strings.ts`.

## Migration note

This contract replaces the old regex/code-patching tap-to-edit approach. The
patcher in `apps/api/src/agent/tapEdit.ts` is deprecated for new builds and will
only be used as a fallback for legacy projects.

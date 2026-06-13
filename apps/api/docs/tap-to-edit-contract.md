# Tap-to-Edit Contract

This is the **single source of truth** for how every tappable element in a v2 app must be labeled so that a tap correctly changes the source code.

The build-time agent (`apps/api/src/agent/prompts.ts`) and the build-time audit
(`apps/api/src/agent/tapEditAudit.ts`) both enforce this contract. The runtime
patcher (`apps/api/src/agent/tapEdit.ts`), the build UI
(`apps/web/src/screens/Build.tsx`), and the bridge
(`infra/expo-template/template-files/appable-bridge.js`) all consume it.

If a build violates this contract, the audit will flag it and the agent will
be told to fix it before the user can interact with the app.

---

## 1. Roles

Every `testID` in a v2 app falls into exactly one of these roles. The role
determines which element the testID labels, what the bridge picks as
`boxTestId`, what the build UI shows in the tap-edit panel, and what the
patcher patches.

### 1.1 Card / Box (2 segments)

A discrete visual card the user might tap to change its background.

| Shape | Examples |
|---|---|
| `<screen>-<thing>` | `home-stat-total`, `home-add-habit`, `home-view-all`, `home-empty`, `home-error`, `home-loading`, `settings-notif-row`, `settings-theme-row`, `add-habit-cancel`, `add-habit-save` |

The **whole** card gets a background edit when the user taps anywhere inside
it. The patcher resolves these to the underlying component
(`Card`, `AppButton`, `EmptyState`, etc.) via the component passthrough.

### 1.2 Card data field (3 segments)

A text/icon inside a card. Always suffixed with the field name.

| Shape | Examples |
|---|---|
| `<card>-<field>` | `home-stat-total-value`, `home-stat-total-label`, `home-view-all-text`, `add-habit-name-label`, `add-habit-cancel-label` |

Suffixes: `-value`, `-label`, `-name`, `-text`, `-desc`, `-message`,
`-header`, `-icon`, `-chevron`, `-tagline`, `-built`, `-version`, `-toggle`,
`-input`.

The bridge's `boxTestId` walks up from a field testID to the parent card.
This way, a tap on the "163" text still has `boxTestId = "home-stat-total"`
(the Card), so background edits land on the Card.

### 1.3 List item row (templated, 4+ segments)

A row inside a mapped list. The row testID is the container; the field
testIDs are the editable labels.

| Shape | Examples |
|---|---|
| `<list>-${id}-row` | `home-habit-${habit.id}-row` |
| `<list>-${id}-<field>` | `home-habit-${habit.id}-name`, `home-habit-${habit.id}-streak` |

A list-item field testID follows the same suffix rules as 1.2
(`-name`, `-title`, `-label`, `-desc`). The row testID ends in `-row`,
`-card`, or `-item` (audit-enforced).

### 1.4 Screen shell (always broad)

The whole screen. Never tappable for individual style.

| Shape | Examples |
|---|---|
| `<screen>-screen` | `home-screen`, `settings-screen`, `add-habit-screen` |

The bridge's `isBroadTestId` recognizes these and excludes them from
`boxTestId`. The build UI's `isCardBoxTestId` also returns `false` for them.

### 1.5 Row / wrapper

A layout container, **not** a card. The bridge won't pick these for
background edits.

| Shape | Examples |
|---|---|
| `<screen>-<list-or-section>` | `home-stats`, `home-quick-list`, `home-quick-title`, `add-habit-name-group` |

Background edits on a row/wrapper would repaint too much. The build UI's
`isCardBoxTestId` returns `false` for these.

### 1.6 Icon

A standalone icon. **Must have its own testID** so taps don't fall back to
the parent row.

| Shape | Examples |
|---|---|
| `<parent>-icon` | `home-add-habit-icon` |
| `<parent>-chevron` | `home-view-all-chevron` |
| `<parent>-close` | `add-habit-cancel-icon` |

Audit-enforced: every `<Ionicons />`, `<MaterialIcons />`, etc. MUST have a
`testID` prop.

---

## 2. Forbidden patterns (audit will reject the build)

These are the exact patterns the build-time audit scans for. A build that
contains any of them is sent back to the agent for a fix-up round before the
user sees the app.

### 2.1 `<Ionicons />` / `<MaterialIcons />` etc. without a `testID`

```jsx
// BAD
<Ionicons name="chevron-forward" size={20} color={colors.primary} />

// GOOD
<Ionicons testID="home-view-all-chevron" name="chevron-forward" size={20} color={colors.primary} />
```

The 10 audited families: `Ionicons`, `MaterialIcons`,
`MaterialCommunityIcons`, `Feather`, `AntDesign`, `Entypo`, `FontAwesome`,
`Foundation`, `Octicons`, `SimpleLineIcons`, `Zocial`.

### 2.2 Raw color literal inside a `StyleSheet.create({...})`

```jsx
// BAD — tap-edit mutates the colors token, not this literal
const styles = StyleSheet.create({
  box: { backgroundColor: "#ff00aa", color: "red" },
});

// GOOD
const styles = StyleSheet.create({
  box: { backgroundColor: colors.primary, color: colors.text },
});
```

Audit-enforced for: `color`, `backgroundColor`, `borderColor`, `tintColor`,
`fillColor`, `strokeColor` set to a hex/rgb/named string inside a
`StyleSheet.create({...})` or `styles = {...}` block.

### 2.3 `<Text>` without a `testID`

Every `<Text>` in `app/(tabs)/`, `app/(stack)/`, `src/components/`, or
`src/screens/` must have a `testID` prop.

```jsx
// BAD
<Text style={styles.label}>Total Days</Text>

// GOOD
<Text testID="home-stat-total-label" style={styles.label}>Total Days</Text>
```

### 2.4 `<Pressable>` inside `.map(...)` without a `-row` / `-card` / `-item` suffix

```jsx
// BAD — the row has no testID at all
{habits.map((h) => (
  <Pressable key={h.id} onPress={() => openHabit(h)}>...</Pressable>
))}

// BAD — wrong suffix
{habits.map((h) => (
  <Pressable testID={`home-habit-${h.id}`} onPress={() => openHabit(h)}>...</Pressable>
))}

// GOOD
{habits.map((h) => (
  <Pressable testID={`home-habit-${h.id}-row`} onPress={() => openHabit(h)}>...</Pressable>
))}
```

### 2.5 Hardcoded user copy in JSX

```jsx
// BAD — copy that the user might want to edit is hardcoded
<Text testID="home-empty-message">No habits yet. Tap + to add one.</Text>

// GOOD — copy lives in src/data/storage.ts and renders as {EMPTY.message}
<Text testID="home-empty-message">{EMPTY_STATE.message}</Text>
```

### 2.6 Day-display ternary / split title

```jsx
// BAD
{day === "Mon" ? "Monday" : day}

// GOOD
{DAYS.find((d) => d.id === day)?.label ?? day}
```

```jsx
// BAD
<Text>{(title || "").split(" ")[0]} <Text>{(title || "").split(" ")[1]}</Text></Text>

// GOOD — one Text, one source string
<Text testID="card-title">{title}</Text>
```

### 2.7 Screen route file in `app/(tabs)/` other than `index.tsx` / `settings.tsx`

Only the Home and Settings tabs live in `app/(tabs)/`. Everything else
(e.g. add-habit, edit-habit, habit-detail) goes in `app/(stack)/`.

---

## 3. The tap pipeline

When the user taps an element, three layers decide what to do. The contract
above must be honored at each layer for a tap to land on the right code.

```
[User taps element with testID "X"]
        │
        ▼
[Bridge: appable-bridge.js]
   emits { testId, boxTestId, textTestId, backgroundOnly, screenBackground }
        │
        ▼
[Build UI: Build.tsx]
   1. isCardBoxTestId(boxTestId) → decides panel title
      ("Screen background" | "Background" | "Element")
   2. Builds the message: `[Tap edit] In the app, find the element with
      testID "X" and {changes}. Change only what was tapped.`
        │
        ▼
[API: tryTapEditPatch]
   1. parseTapEditRequest(message) → { testId, changes, screen }
   2. findComponentInstantiation(sources, testId) → which file to patch
   3. attemptTapEditPatch → patched file + diff
```

### 3.1 Common mislabels and their fixes

| Mislabel | What the user sees | Root cause | Fix |
|---|---|---|---|
| 163 box | Tap card → panel says "Screen background" | `isCardBoxTestId` had `^stat-` (start-anchored) regex but live testIDs are `home-stat-*` | Removed the start anchor; now matches `home-stat-*` and any text-leaf suffix. |
| Empty state | Tap empty placeholder → no patch | `findComponentInstantiation` regex couldn't handle nested JSX child props (`icon={<Ionicons ... />}`) | Rewrote to walk back from the testID literal to the opening `<` and use `scanOpeningTagEnd`. |
| Chevron without testID | Tap chevron → parent row repainted | `<Ionicons />` emitted without a testID; bridge fell back to parent | Audit now requires `testID` on every icon. |
| Raw color in StyleSheet | Tap → "change color" does nothing | Patch mutates the `colors` token, not the literal | Audit now flags raw hex/rgb/named colors in `StyleSheet.create({...})`. |
| Mapped row without `-row` | Tap row → patcher may patch every sibling | Patcher can't safely scope the change | Audit requires `-row` / `-card` / `-item` suffix on mapped Pressables. |

### 3.2 Debugging a new mislabel

1. **Look at the tap-trace log** (`apps/api/scripts/tap-trace.mjs`) to see
   what each layer decided for the failing testID.
2. **Find the row in the "Roles" table** that the testID is supposed to
   match. If it doesn't match any role, the testID is malformed.
3. **If the testID matches a role but the layer is wrong**, the fix is in
   that layer:
   - **Bridge** (`appable-bridge.js`): the `boxTestId` is wrong, or
     `backgroundOnly` / `screenBackground` is mis-detected.
   - **Build UI** (`Build.tsx`): the panel title is wrong, or the message
     sent to the API references the wrong testID.
   - **API patcher** (`tapEdit.ts`): the patcher can't find the testID, or
     the patch lands on the wrong line. Check `findComponentInstantiation`
     and the `patchComponentPassthroughInSources` branch selection.
4. **If the testID is wrong in source**, the audit should have caught it
   at build time. If the audit missed it, add a check to
   `apps/api/src/agent/tapEditAudit.ts`.

---

## 4. How to extend the contract

When you add a new component or pattern:

1. **Pick a role** (or define a new one) and document the testID shape.
2. **Update the build-time agent prompt** to teach the new shape, with a
   positive example and a negative example.
3. **Add an audit check** in `apps/api/src/agent/tapEditAudit.ts` to enforce
   the shape — name the issue kind like `<thing>-missing-testid` or
   `<thing>-bad-testid-suffix`.
4. **Add a unit test** to `apps/api/scripts/tap-misroute-test.mjs` (or a new
   suite) that exercises the new pattern end-to-end.
5. **Update the misroute / label-audit scripts** to include the new testID
   shape.
6. **Add a tap-trace entry** so the next time someone reports a mislabel, the
   layer-by-layer decisions are visible in the log.

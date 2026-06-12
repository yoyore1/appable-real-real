# Tap-to-Edit v2 — full engineering spec

**Goal:** v2 apps (Expo Router, data-driven lists) must save every tap-to-edit change to source with the same reliability v1 had — preview and refresh must match.

See also: `tap-to-edit-v2.md` (product contract), `rollback-v1.md`.

---

## 1. Why v1 felt better (and what v2 must replicate)

| Layer | v1 reality | v2 reality | Gap |
|-------|------------|------------|-----|
| **Codegen** | Literal strings in JSX; simple cards | `{item.field}` + `storage.ts` + `.map()` | Patcher can't grep `"Morni"` in route files |
| **Preview** | DOM text ≈ source text | DOM from AsyncStorage/localStorage | Rename in storage ≠ preview until sync |
| **Patcher** | Patch literal / day-ternary patterns | Needs id-scoped conditionals | Shared `.map()` template → one bad patch tints all rows |
| **Gates** | Audit + manual QA | Audit + probe (text only today) | Color/bg/font not probed |

**v2 app architecture is correct long-term.** This spec closes the tooling gap — not by reverting to v1 JSX literals.

---

## 2. Design principle (unchanged)

```
Tap → bridge (instant preview) → [Tap edit] message → patcher → source file(s) → refresh persists
```

Three systems must agree on one contract:

1. **Codegen** — agent generates save-friendly shapes  
2. **Bridge + Build UI** — sends correct testIDs and change messages  
3. **Patcher** — routes each change to the right file + pattern  

---

## 3. Codegen contract (agent + golden template)

### 3.1 File ownership

| Owner | Paths |
|-------|-------|
| Platform (never agent) | `app/_layout.tsx`, `app/(tabs)/_layout.tsx`, `app/(stack)/_layout.tsx`, `appable-bridge.js` |
| Agent | `app/(tabs)/index.tsx`, `app/(tabs)/settings.tsx`, `app/(stack)/*.tsx`, `src/components/*`, `src/lib/*` |
| Shared values | `src/theme/tokens.ts` (screen background only) |

### 3.2 testID schema

```
{route}-screen              Screen root (broad — screen bg only)
{route}-title                 Page title Text
{route}-{section}-title       Section headers
{prefix}-{id}-name            Data field: name   (habit.name)
{prefix}-{id}-title           Data field: title
{prefix}-{id}-desc            Data field: description
{prefix}-{id}-row             Mapped row/card Pressable (background edits)
stat-{name}                   Static stat cards (literal text OK)
```

**Templates for lists (required):**

```tsx
{items.map((item) => (
  <Pressable
    key={item.id}
    testID={`home-habit-${item.id}-row`}
    style={styles.card}
  >
    <Text testID={`home-habit-${item.id}-name`} style={styles.habitName}>
      {item.name}
    </Text>
  </Pressable>
))}
```

Rules:

- Iterator param name must match template: `${item.id}` → `.map((item) => ...)`
- **Both** row testID (`-row`) and label testID (`-name`) on every mapped row
- Never split one label across multiple `Text` nodes
- User-visible strings in `src/lib/storage.ts` (or typed data module), not JSX literals

### 3.3 Forbidden patterns (audit hard-fail)

- `title.split()`, `renderTitle()`, day === 'Mon' ? "Monday" : day
- Mapped row without `-row` testID on Pressable
- `{item.name}` Text without `-name` testID suffix
- Routes other than index/settings under `app/(tabs)/`

---

## 4. Save routing matrix (patcher)

Every `[Tap edit]` change type must resolve through this table. **Never** apply unconditional `style={{ backgroundColor }}` on a `.map()` template tag.

### 4.1 Text replace

| Code pattern | File | Patch strategy |
|--------------|------|----------------|
| Literal in JSX | Route file | Replace literal / expression in Text |
| `{item.field}` + testID `{prefix}-{id}-name` | `src/lib/storage.ts` (or data file) | `patchObjectFieldById(id, field, old, new)` |
| `{CONST}` identifier | Route or const file | Patch const string |
| `.map()` + `{item.field}` only | storage + preview sync | storage patch + `appable:sync-storage-field` |

### 4.2 Text color / fontWeight / fontFamily

| Code pattern | File | Patch strategy |
|--------------|------|----------------|
| Static testID on Text | Route file | Inline style on tag |
| `{prefix}-{id}-name` template | Route file | `{ item.id === 'h1' && { color: '…' } }` on Text style array |
| Prop-keyed card (`meal-plan-${day}`) | Route file | `const labelStyle = day === 'Tue' ? [styles.x, { color }] : styles.x` |
| Anchor label only (no testID) | Route file | Resolve id from storage by name → list-item conditional |

**Priority order:** prop-keyed → **list-item id conditional** → day-suffix map → static tag.  
**Never:** unconditional color on shared map template.

### 4.3 Card / row background

| Code pattern | File | Patch strategy |
|--------------|------|----------------|
| `{prefix}-{id}-row` template | Route file | `{ item.id === 'h1' && { backgroundColor: '…' } }` on Pressable |
| Text testID only (no row id) | Route file | Find parent Pressable in map scope → id conditional |
| Static stat card testID | Route file | Inline or StyleSheet patch |
| Anchor `"Morni"` + row testID | Route file | Prefer testID path; anchor resolves id via storage |

**Never:** patch `styles.card` in StyleSheet when intent is one row.

### 4.4 Screen background

| Target | File | Patch strategy |
|--------|------|----------------|
| `{route}-screen` / empty tap | `src/theme/tokens.ts` | `colors.background` or `colors.groupedBackground` |
| Fallback | Route file | Root ScrollView / Screen style (last resort) |

### 4.5 Non-editable (ignore)

- Tab bar, stack header, `*-scroll`, `*-safe`, `*-layout`

---

## 5. Build UI + bridge contract

### 5.1 Message target selection (`Build.tsx`)

Always prefer **testID** over anchor label when available:

| User action | `find` target | Changes |
|-------------|---------------|---------|
| Text + color | `testID "{textTestId}"` | replace + `set the text color to #…` |
| Row background | `testID "{boxTestId}"` | `set the background color to #…` |
| Text + row bg | `testID "{boxTestId}"` if bg changed; text via textTestId | both changes in one message |
| Screen bg | `the main screen background` | `set the screen background color to #…` |

Do **not** use `set the text color of "Morni"` when `textTestId` is known — use testID-only color clause so patcher hits list-item path.

### 5.2 Preview sync (bridge)

| Edit type | Bridge action |
|-----------|---------------|
| List item rename | `appable:sync-storage-field` → update habits array in localStorage |
| List item color/bg | Apply to DOM node by testID; refresh loads from patched source |
| Screen bg | Apply to screen root + tokens on save |

### 5.3 Payload requirements (bridge → Build)

Every tap must send:

- `textTestId` — label Text testID (runtime value, e.g. `home-habit-h1-name`)
- `boxTestId` — row/card container testID (e.g. `home-habit-h1-row`)
- `backgroundOnly`, `anchorLabel` — for disambiguation only; save uses testIDs first

---

## 6. Gates (same rigor as v1 build discipline)

### 6.1 Static audit (`tapEditAudit.ts`)

Existing checks + add:

- [ ] Mapped `Pressable`/`TouchableOpacity` missing `-row` testID
- [ ] `{item.field}` Text missing matching `-{field}` testID suffix

### 6.2 Patch probe (`tapEditProbe.ts`)

Extend dry-run beyond text replace:

| Probe | Message |
|-------|---------|
| Text replace | `buildTapEditReplaceMessage(testId, text, text')` |
| Text color | `set the text color to #ff5500` + testId |
| Row bg | `set the background color to #112233` + boxTestId |
| Screen bg | `set the screen background color to #aabbcc` |

Collect targets from templates × storage ids (same as text probe expansion).

**Build gate:** `issuesAfter === 0` AND probe failures === 0 before build completes.

### 6.3 Local regression scripts

| Script | Covers |
|--------|--------|
| `tap-color-test.mjs` | List name color, row bg, screen bg (inline sample) |
| `tap-morning-test.mjs` | GymStreak text replace + storage |
| `tap-list-style-test.mjs` | (new) multi-item map — only h1 changes |

---

## 7. Implementation phases

### Phase A — Patcher parity (platform, no agent change)

- [x] `parseListItemTestContext` / `findListItemTemplateElement`
- [x] `patchListItemMapStyle` (id conditional for color + bg)
- [x] `tapEditDiscovery.ts` — dynamic template × data resolution
- [x] Block unconditional style on map templates (guard)
- [x] Anchor fallback: resolve label → storage id → list-item testID
- [x] Row bg when only label testID present (candidate row suffixes)
- [x] `Build.tsx`: testID-only color/bg/font messages

### Phase B — Preview sync

- [x] `parseListFieldStorageSync` + bridge handler for renames
- [ ] Optional: preview-only list style hints (or rely on Metro refresh)

### Phase C — Gates

- [x] Probe: color + background per probed list row
- [x] Audit: `-row` / `-card` suffix on mapped Pressables
- [ ] Hygiene heal prompt: enforce row testID in fixes

### Phase D — Acceptance

Run on **fresh v2-native build** (not GymStreak alone):

1. Tap habit name → rename → refresh persists  
2. Tap habit name → text color → **only that row** → refresh persists  
3. Tap habit card padding → bg → **only that row** → refresh persists  
4. Tap empty screen → screen bg → `tokens.ts` → refresh persists  
5. Tap tab bar → hint, no save panel flood  
6. Undo restores previous source  
7. Expo Go matches web preview  

GymStreak: repair pass adds missing `-row` testIDs if absent.

---

## 8. Acceptance checklist (copy for QA)

```
[ ] Text rename on mapped list item
[ ] Text color on mapped list item (single row only)
[ ] Row/card background (single row only)
[ ] Screen background → tokens.ts
[ ] Stat card (static testID) background
[ ] Font weight / family on label
[ ] Tab bar ignored
[ ] Undo
[ ] Refresh / Expo Go parity
[ ] Build probe passes (text + color + bg)
```

---

## 9. Summary

**v2 codegen is the long-term win.** Tap-to-edit v2 engineering means:

1. **Strict list testIDs** (`-name` + `-row`)  
2. **Patcher routes by id**, not by visible string  
3. **Build UI sends testIDs**, not anchor labels, when possible  
4. **Probe all edit types** before ship  
5. **Never patch shared map templates unconditionally**  

When this spec is fully implemented, v2 matches v1 reliability with better app architecture.

---

## 10. Dynamic discovery (any app, no hardcodes)

The platform must not special-case GymStreak, habits, or `home-habit`. All list-item logic lives in **`tapEditDiscovery.ts`**:

| Step | What happens |
|------|----------------|
| **Discover templates** | Scan route files for `` testID={`{prefix}-${item.id}-name`} `` |
| **Discover data** | Scan `src/lib/*` for `{ id: "…", field: "…" }` blocks |
| **Expand runtime IDs** | Template × every record id → `todo-a1-title`, `recipe-r2-name`, … |
| **Resolve anchor fallback** | Visible label → match record field value → expanded testID |
| **Pick strategy** | DATA_FIELD (text) / MAP_ROW_STYLE (color,bg,font) / STATIC / PROP_KEYED |
| **Guard** | `isSharedMapTemplateElement` → never unconditional style on `.map()` tags |

**Strategy registry (patcher priority):**

1. Prop-keyed (`meal-plan-${day}` + component prop)
2. List-item id conditional (`${item.id}` templates + storage)
3. Day-suffix map (`week-day-Tue`)
4. Static testID inline style
5. Screen → `tokens.ts`

**Build UI rule:** save messages use **runtime testID only** — anchor labels are fallback when testID missing (audit should flag that).

**Probe rule:** for every discovered label target, dry-run **text + color + row background** before build passes.

Implementation: `apps/api/src/agent/tapEditDiscovery.ts` + extended `tapEditProbe.ts`.

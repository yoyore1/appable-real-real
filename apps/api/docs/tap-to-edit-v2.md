# Tap-to-Edit v2 — spec (Expo Router + native iOS)

**Prerequisite for v2 golden migration.** Nav and Layer 2 iOS feel are built *inside* this contract.

See also: `rollback-v1.md` — always snapshot v1 before starting.

---

## Principle

- **Preview:** bridge hits web DOM in iframe → instant apply  
- **Persist:** patcher writes source → refresh keeps change  
- **v2 shape:** `app/(tabs)/*.tsx` + platform-owned `_layout.tsx`  
- **Screen bg:** `src/theme/tokens.ts` (`colors.background`)  
- **Native chrome:** tab bar, stack nav bar — **not editable**

---

## Platform-owned (agent never rewrites)

- `app/_layout.tsx`, `app/(tabs)/_layout.tsx`
- `appable-bridge.js`, `index.ts` import
- Bridge + patcher platform code in API repo

## Agent-owned (editable)

- `app/(tabs)/{screen}.tsx` — content with testIDs
- `src/components/*`, `src/lib/*`
- `src/theme/tokens.ts` — values only (background color patches)

---

## testID contract

- Screen: `{route}-screen` on `Screen`
- Titles: `{route}-title`, `{route}-{section}-title`
- Cards/rows: `{route}-{name}`, lists `{prefix}-${id}`
- **Broad IDs blocked:** `*-scroll`, `*-safe`, `*-layout`, tab bar, nav header

Every user-visible `Text` must have a testID (audit gate).

---

## Edit modes (bridge v14)

| Tap | Panel | Save target |
|-----|-------|-------------|
| Text | Text, color, font | testID → route file |
| Card padding | Background only | testID → card View |
| Empty page | Screen background | `tokens.ts` |
| Tab bar | Ignore / hint | — |

Payload flags: `backgroundOnly`, `screenBackground: true`.

---

## Save messages (unchanged format)

- Screen: `find the main screen background and set the screen background color to #RRGGBB`
- Card: `find the element with testID "…" and set the background color to #RRGGBB`
- Text: existing replace / color / font patterns

Patcher priority for screen bg: `tokens.ts` → root shell → route ScrollView (last resort).

---

## Web preview vs phone

- Editable UI lives in **`Screen` content** (large titles as in-content `Text`), not nav header options.
- Tab bar: native on device, styled fallback on web with `data-appable="non-editable"`.

---

## Phases

1. **Router scaffold + testIDs + patcher paths** (no NativeTabs) — edit must pass  
2. **NativeTabs + stack** — tab bar non-editable; content edit unchanged  
3. **SF Symbols, context menus** — edit row, not menu chrome  

---

## Acceptance (before v2 replaces `latest`)

1. Tap text → save → refresh persists  
2. Tap stat card bg → save → refresh persists  
3. Tap empty area → screen bg → save → refresh persists (`tokens.ts`)  
4. Tap tab bar → no flood panel  
5. Undo works  
6. Expo Go matches preview colors  

Do not merge v2 to `main` or overwrite `appable/expo-template:v1` until all pass.

# APPABLE — SLOP PREVENTION METHODOLOGY (standalone)

This is the general system for making every failure class preventable in the FIRST build — not caught and patched after. It governs how the generation system (golden template + specs + M2.7) evolves over time. Read alongside the code-discipline and design-plan docs; this is the meta-layer that explains how those docs grow.

---

## THE CORE THEORY
**Slop happens where the model has freedom it shouldn't have.** Every generation flaw maps to one of four root causes. Each root cause has one mechanical fix. The job is to classify each flaw and apply its fix — permanently.

> **Template what repeats. Cap what needs taste. Derive what must agree. Simulate what must be seen.**

---

## THE FOUR ROOT CAUSES AND THEIR FIXES

### 1. Setup work the model skips → BAKE IT INTO THE TEMPLATE
Anything identical across all apps must never be generated: font loading, config (babel/metro), theme tokens, navigation shell, auth scaffolding, storage setup, hygiene utilities.
- **Rule of thumb:** if two different apps would need identical code for it, it belongs in the golden template, not in generation.
- Generation produces ONLY what is unique to this specific app.
- Every item moved from "generated" to "template" eliminates its failure class forever (e.g., system-font slop dies the day fonts are preloaded in the template).

### 2. Decisions with known-good answers → CONSTRAIN WITH NUMBERS, NOT TASTE
Models follow hard limits perfectly and exercise taste unreliably. Convert every "use good judgment" into a number or cap:
- Max 5 bottom tabs (prefer 4); Settings is never a tab when the bar is full
- Primary color on ≤ ~30% of a screen's elements (CTAs, active states, progress fills, success moments ONLY; big stat numbers are ink/charcoal)
- 3 typographic levels per screen minimum
- ONE **dominant** CTA per screen — one visually-primary action (solid primary-color button). Secondary/tertiary actions (text buttons, row taps, icon actions) are fine and expected. The budget is on visual dominance, NOT total button count.
- File length: ~150 lines is SOFT guidance, not a cap. **The edit contract always wins:** never split a file if splitting would break testIDs, split a Text node, or move a label out of the patcher's reach. When file size and tap-to-edit integrity conflict, keep the file whole.
- Seed data produces VISIBLE states: progress bars 30–70% filled, lists with 8–15 varied records
- **Wherever a spec would say "use good judgment," replace it with a numeric budget or hard cap. Judgment is where slop lives.** (Hierarchy of constraints: edit contract > numeric budgets > soft guidance. Where they conflict, the harder constraint wins.)

### 3. Things that must agree with each other → SINGLE SOURCE OF TRUTH, DERIVE EVERYTHING
Any value appearing in 2+ places (totals across screens, colors, spacing, user-visible strings) must be DERIVED from one definition — a seed-data module, tokens file, or store — never restated.
- Progress indicators compute from real data (`saved/target`) — never hardcoded widths
- The same metric (e.g., total saved) must be identical on every screen it appears, because every screen reads the same store
- **The model may define a fact once and reference it everywhere. Defining the same fact twice is forbidden.** Inconsistency becomes structurally impossible instead of needing to be caught.

### 4. Failures only visible by LOOKING → ENCODE ADVERSARIAL SIMULATION CHECKS
**For launch: this is MENTAL simulation inside the Rule 7 self-review — no vision pass, no screenshot gate, no second build pass.** The generation model stress-tests its own output by reasoning, not by rendering:
- Render every label+value row mentally with a 20-character name: anything overlap? (Layout rule: label gets flex:1 + numberOfLines={1} + ellipsize; value gets intrinsic width; no absolute positioning for either)
- Render every list with 0 items and with 100 items: blank screens? broken scroll?
- Check every progress/chart element against its underlying data: does the visual contradict the numbers?
- Check the tab bar: labels clipping? more than 5 tabs?
- Check every screen on a small device width: anything cut off?

**Phase 2 (optional automation of this cause, NOT in v1):** a post-polish vision pass — 1–3 fixed screenshots (the messy screens: home/dashboard, not already-clean auth) → Qwen3-VL-30B-A3B on DeepInfra → structured JSON findings (truncation, contrast, overlap) → MiniMax surgical edits. Validated in testing (Savings Quest spike): pipeline works, marginal gain on clean screens, real gain on messy home UIs. It is an OPTIONAL post-pass, never a mandatory gate blocking builds. Add only when deliberately scheduled.

---

## THE COMPOUNDING LOOP (how the system gets better forever)
Every time ANY build ships a flaw, run a five-minute autopsy:
1. **Classify:** which root cause? (skipped setup / unconstrained freedom / duplicated truth / unverified visual)
2. **Write the prevention** in that cause's native form: a template addition, a numeric constraint, a derive-don't-restate rule, or a simulation check.
3. **Add it to the relevant spec** (template, design plan, code discipline, or this doc's checklists).
4. That failure class never recurs.

The specs are the accumulated autopsy of every flaw ever caught, encoded as prevention. This is the moat: months in, the golden template + constraint set embodies hundreds of permanently-fixed failure classes that competitors' raw prompts still produce daily.

## SCOPE GUARDRAILS (per the v2 merge — binding)
- **Template owns:** fonts, tokens, auth, storage, base components, platform glue (bridge + entry import), and the nav shell (**App.tsx state navigation — NO Expo Router, NO /features layout**). Generation builds ONLY app-specific screens/data.
- **No stack change** in this merge: no Tamagui, Zustand, Expo Router, or FlashList. Those remain a separately-scheduled v2 platform target.
- **No mandatory vision gate** blocking builds (vision = optional Phase 2 post-pass per Cause 4).
- **Metro/babel/bridge are platform-owned** — never agent-editable; tool blocks enforce this.

## OPERATING PRINCIPLE
Flaws found in builds are not bugs — they are spec contributions. The response to a flaw is never just "fix this app." It is always "fix this app AND classify-prevent so no future app can have it."

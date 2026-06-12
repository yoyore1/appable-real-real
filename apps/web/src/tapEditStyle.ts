/** Font presets for tap-to-edit (RN + web safe). */
export type TapFontPreset = "sans" | "serif" | "mono";

export const TAP_FONT_OPTIONS: { id: TapFontPreset; label: string }[] = [
  { id: "sans", label: "Default" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Monospace" },
];

/** Values written into source / preview. */
export const TAP_FONT_CSS: Record<TapFontPreset, string> = {
  sans: "System",
  serif: "Georgia",
  mono: "monospace",
};

export function isBoldWeight(fontWeight: string): boolean {
  const n = parseInt(fontWeight, 10);
  if (!Number.isNaN(n)) return n >= 600;
  const w = fontWeight.toLowerCase();
  return w === "bold" || w === "bolder";
}

export function fontPresetFromComputed(fontFamily: string): TapFontPreset {
  const low = fontFamily.toLowerCase();
  if (low.includes("mono") || low.includes("courier") || low.includes("consolas")) {
    return "mono";
  }
  if (
    low.includes("georgia") ||
    low.includes("times") ||
    low.includes("fraunces") ||
    low.includes("serif")
  ) {
    return "serif";
  }
  return "sans";
}

/** Patcher message label (capitalized). */
export function fontPresetLabel(preset: TapFontPreset): string {
  return TAP_FONT_OPTIONS.find((o) => o.id === preset)?.label ?? "Default";
}

/** Sync AsyncStorage/localStorage when a list-item name field is tap-edited. */
export function parseListFieldStorageSync(
  testId: string | null | undefined,
  value: string,
): { recordId: string; field: string; value: string } | null {
  if (!testId) return null;
  const nameMatch =
    testId.match(/home-habit-([^-]+)-name$/) ??
    testId.match(/habit-([^-]+)-name$/);
  if (nameMatch) {
    return { recordId: nameMatch[1], field: "name", value };
  }
  const titleMatch =
    testId.match(/home-habit-([^-]+)-title$/) ?? testId.match(/habit-([^-]+)-title$/);
  if (titleMatch) {
    return { recordId: titleMatch[1], field: "title", value };
  }
  return null;
}

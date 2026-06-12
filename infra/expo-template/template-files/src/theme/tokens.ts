/**
 * iOS-native design tokens — neutral system defaults.
 * On first build: set colors.primary from spec.vibe.primaryColor in tokens.ts.
 */
import { Platform, PlatformColor, StyleSheet } from "react-native";

const web = {
  label: "#000000",
  secondaryLabel: "rgba(60, 60, 67, 0.6)",
  tertiaryLabel: "rgba(60, 60, 67, 0.3)",
  systemBackground: "#FFFFFF",
  secondarySystemGroupedBackground: "#F2F2F7",
  separator: "rgba(60, 60, 67, 0.29)",
  systemGreen: "#34C759",
  systemRed: "#FF3B30",
  systemBlue: "#007AFF",
  systemOrange: "#FF9500",
  fill: "#E9E9EB",
  tabInactive: "#8E8E93",
} as const;

type SemanticKey = keyof typeof web;

function semantic(name: SemanticKey): string {
  if (Platform.OS === "ios" && typeof PlatformColor === "function") {
    return PlatformColor(name) as unknown as string;
  }
  return web[name];
}

/** Brand tint — override from spec.vibe.primaryColor during build. */
export let colors = {
  label: semantic("label"),
  secondaryLabel: semantic("secondaryLabel"),
  tertiaryLabel: semantic("tertiaryLabel"),
  groupedBackground: semantic("secondarySystemGroupedBackground"),
  surface: semantic("systemBackground"),
  separator: semantic("separator"),
  searchFill: semantic("fill"),
  primary: web.systemBlue,
  primaryText: "#FFFFFF",
  danger: semantic("systemRed"),
  success: semantic("systemGreen"),
  warning: semantic("systemOrange"),
  tabInactive: web.tabInactive,
};

/** Call once after reading spec to apply customer brand color. */
export function applyBrandPrimary(hex: string): void {
  colors = { ...colors, primary: hex };
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 10,
  md: 12,
  lg: 14,
  sheet: 10,
  pill: 999,
};

export const layout = {
  rowMinHeight: 44,
  buttonHeight: 50,
  marginHorizontal: 16,
  hairline: StyleSheet.hairlineWidth,
  separatorInset: 16,
};

const systemFont = Platform.select({ ios: "System", default: undefined });

export const type = {
  largeTitle: {
    fontSize: 34,
    fontWeight: "700" as const,
    fontFamily: systemFont,
    color: colors.label,
    letterSpacing: 0.37,
  },
  title1: {
    fontSize: 28,
    fontWeight: "700" as const,
    fontFamily: systemFont,
    color: colors.label,
  },
  title2: {
    fontSize: 22,
    fontWeight: "700" as const,
    fontFamily: systemFont,
    color: colors.label,
  },
  headline: {
    fontSize: 17,
    fontWeight: "600" as const,
    fontFamily: systemFont,
    color: colors.label,
  },
  body: {
    fontSize: 17,
    fontWeight: "400" as const,
    fontFamily: systemFont,
    color: colors.label,
    lineHeight: 22,
  },
  subhead: {
    fontSize: 15,
    fontWeight: "400" as const,
    fontFamily: systemFont,
    color: colors.label,
    lineHeight: 20,
  },
  footnote: {
    fontSize: 13,
    fontWeight: "400" as const,
    fontFamily: systemFont,
    color: colors.secondaryLabel,
    lineHeight: 18,
  },
  caption: {
    fontSize: 12,
    fontWeight: "400" as const,
    fontFamily: systemFont,
    color: colors.secondaryLabel,
    lineHeight: 16,
  },
  button: {
    fontSize: 17,
    fontWeight: "600" as const,
    fontFamily: systemFont,
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: "500" as const,
    fontFamily: systemFont,
  },
};

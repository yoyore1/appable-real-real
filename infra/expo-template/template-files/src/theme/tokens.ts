/** Appable design tokens — warm, premium baseline. Override primary per app spec. */

export const colors = {
  background: "#FBF9F5",
  surface: "#FFFFFF",
  text: "#2C2825",
  textMuted: "#6B6560",
  border: "#E8E1D6",
  /** Replace with spec.vibe.primaryColor at runtime if needed */
  primary: "#C8431D",
  primaryText: "#FFFFFF",
  danger: "#B42318",
  success: "#3D7A50",
};

export const spacing = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  pill: 999,
};

export const shadow = {
  card: {
    shadowColor: "#1C1814",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
};

export const type = {
  title: { fontSize: 26, fontWeight: "700" as const, color: colors.text },
  subtitle: { fontSize: 17, fontWeight: "600" as const, color: colors.text },
  body: { fontSize: 16, fontWeight: "400" as const, color: colors.text, lineHeight: 24 },
  meta: { fontSize: 13, fontWeight: "500" as const, color: colors.textMuted },
  button: { fontSize: 16, fontWeight: "600" as const },
};

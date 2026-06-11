import { Pressable, StyleSheet, Text, type TextProps } from "react-native";
import { colors, radius, spacing, type as typeScale } from "../theme/tokens.js";

type Props = {
  label: string;
  testID: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  labelProps?: TextProps;
};

export function AppButton({
  label,
  testID,
  onPress,
  variant = "primary",
  disabled,
  labelProps,
}: Props) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text testID={`${testID}-label`} style={[styles.label, styles[`${variant}Label`]]} {...labelProps}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  danger: { backgroundColor: colors.danger },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  label: { ...typeScale.button },
  primaryLabel: { color: colors.primaryText },
  secondaryLabel: { color: colors.text },
  dangerLabel: { color: colors.primaryText },
});

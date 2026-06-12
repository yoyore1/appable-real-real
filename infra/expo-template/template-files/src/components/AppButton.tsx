import { Pressable, StyleSheet, Text, type TextProps } from "react-native";
import { hapticLight } from "../lib/haptics.js";
import { colors, layout, radius, spacing, type as typeScale } from "../theme/tokens.js";

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
  const handlePress = () => {
    void hapticLight();
    onPress();
  };

  if (variant === "secondary") {
    return (
      <Pressable
        testID={testID}
        onPress={handlePress}
        disabled={disabled}
        style={({ pressed }) => [styles.textBtn, disabled && styles.disabled, pressed && styles.pressedText]}
      >
        <Text
          testID={`${testID}-label`}
          style={[styles.textBtnLabel, { color: colors.primary }]}
          {...labelProps}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  if (variant === "danger") {
    return (
      <Pressable
        testID={testID}
        onPress={handlePress}
        disabled={disabled}
        style={({ pressed }) => [styles.textBtn, disabled && styles.disabled, pressed && styles.pressedText]}
      >
        <Text testID={`${testID}-label`} style={styles.dangerLabel} {...labelProps}>
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      testID={testID}
      onPress={handlePress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: colors.primary },
        disabled && styles.disabled,
        pressed && !disabled && styles.pressedPrimary,
      ]}
    >
      <Text testID={`${testID}-label`} style={styles.primaryLabel} {...labelProps}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: {
    minHeight: layout.buttonHeight,
    borderRadius: radius.lg,
    paddingHorizontal: layout.marginHorizontal,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: { ...typeScale.button, color: colors.primaryText },
  textBtn: {
    minHeight: layout.rowMinHeight,
    paddingHorizontal: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  textBtnLabel: { ...typeScale.button },
  dangerLabel: { ...typeScale.button, color: colors.danger },
  disabled: { opacity: 0.4 },
  pressedPrimary: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  pressedText: { opacity: 0.5 },
});

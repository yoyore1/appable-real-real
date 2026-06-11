import { Pressable, StyleSheet, View, type ViewProps } from "react-native";
import { colors, radius, shadow, spacing } from "../theme/tokens.js";

type Props = ViewProps & {
  testID?: string;
  onPress?: () => void;
};

export function Card({ children, testID, onPress, style, ...rest }: Props) {
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        style={({ pressed }) => [styles.card, pressed && styles.pressed, style]}
        {...rest}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View testID={testID} style={[styles.card, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    ...shadow.card,
  },
  pressed: { opacity: 0.92 },
});

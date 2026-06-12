import { Pressable, StyleSheet, View, type ViewProps } from "react-native";
import { colors, radius, spacing } from "../theme/tokens";

type Props = ViewProps & {
  testID?: string;
  onPress?: () => void;
};

/** iOS grouped card — no elevation shadow; contrast from grouped background. */
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
    overflow: "hidden",
  },
  pressed: { opacity: 0.7 },
});

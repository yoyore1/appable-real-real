import type { ReactNode } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import { colors, radius, spacing } from "../theme/tokens.js";

type Props = ViewProps & {
  testID?: string;
  children: ReactNode;
};

/** Inset grouped section — white rounded rect on grouped background. */
export function GroupedSection({ children, testID, style, ...rest }: Props) {
  return (
    <View testID={testID} style={[styles.section, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    overflow: "hidden",
    marginBottom: spacing.md,
  },
});

import { StyleSheet, View, type ViewProps } from "react-native";
import { spacing } from "../theme/tokens.js";

type Props = ViewProps & {
  testID?: string;
  gap?: number;
};

/** Horizontal row for icon + label pairs (tap-to-edit friendly). */
export function Row({ children, testID, gap = spacing.sm, style, ...rest }: Props) {
  return (
    <View testID={testID} style={[styles.row, { gap }, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
});

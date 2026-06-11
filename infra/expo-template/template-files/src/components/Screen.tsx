import { SafeAreaView, ScrollView, StyleSheet, View, type ViewProps } from "react-native";
import { colors, spacing } from "../theme/tokens.js";

type Props = ViewProps & {
  scroll?: boolean;
  testID?: string;
};

export function Screen({ children, scroll, testID, style, ...rest }: Props) {
  const body = scroll ? (
    <ScrollView contentContainerStyle={styles.scroll} testID={testID ? `${testID}-scroll` : undefined}>
      {children}
    </ScrollView>
  ) : (
    <View style={styles.body} testID={testID}>
      {children}
    </View>
  );

  return (
    <SafeAreaView style={[styles.root, style]} testID={testID ? `${testID}-safe` : undefined} {...rest}>
      {body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1, padding: spacing.md },
  scroll: { flexGrow: 1, padding: spacing.md },
});

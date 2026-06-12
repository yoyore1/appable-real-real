import { Platform, SafeAreaView, ScrollView, StyleSheet, Text, View, type ViewProps } from "react-native";
import { colors, layout, spacing, type as typeScale } from "../theme/tokens.js";

type Props = ViewProps & {
  scroll?: boolean;
  testID?: string;
  title?: string;
  largeTitle?: boolean;
};

const scrollProps =
  Platform.OS === "ios"
    ? {
        keyboardDismissMode: "interactive" as const,
        contentInsetAdjustmentBehavior: "automatic" as const,
        bounces: true,
        decelerationRate: "normal" as const,
      }
    : {};

export function Screen({ children, scroll, testID, title, largeTitle, style, ...rest }: Props) {
  const header =
    title != null ? (
      <Text
        testID={testID ? `${testID}-title` : undefined}
        style={largeTitle ? styles.largeTitle : styles.title}
      >
        {title}
      </Text>
    ) : null;

  const body = scroll ? (
    <ScrollView
      testID={testID ? `${testID}-scroll` : undefined}
      contentContainerStyle={styles.scrollContent}
      {...scrollProps}
    >
      {header}
      {children}
    </ScrollView>
  ) : (
    <View style={styles.body} testID={testID}>
      {header}
      {children}
    </View>
  );

  return (
    <SafeAreaView
      style={[styles.root, style]}
      testID={testID ? `${testID}-safe` : undefined}
      {...rest}
    >
      {body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.groupedBackground },
  body: { flex: 1, paddingHorizontal: layout.marginHorizontal },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: layout.marginHorizontal,
    paddingBottom: spacing.lg,
  },
  largeTitle: { ...typeScale.largeTitle, marginTop: spacing.sm, marginBottom: spacing.md },
  title: { ...typeScale.title2, marginTop: spacing.sm, marginBottom: spacing.md },
});

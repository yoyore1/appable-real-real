import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing, type as typeScale } from "../theme/tokens.js";
import { AppButton } from "./AppButton.js";

type Props = {
  testID: string;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
};

export function EmptyState({ testID, title, message, actionLabel, onAction, icon }: Props) {
  return (
    <View testID={testID} style={styles.wrap}>
      {icon}
      <Text testID={`${testID}-title`} style={styles.title}>
        {title}
      </Text>
      <Text testID={`${testID}-message`} style={styles.message}>
        {message}
      </Text>
      {actionLabel && onAction ? (
        <AppButton label={actionLabel} testID={`${testID}-action`} onPress={onAction} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: spacing.xl, gap: spacing.sm },
  title: { ...typeScale.headline, textAlign: "center" },
  message: { ...typeScale.body, color: colors.secondaryLabel, textAlign: "center" },
});

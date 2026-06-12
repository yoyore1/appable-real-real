import { useEffect } from "react";
import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, spacing, type as typeScale } from "../theme/tokens.js";

export type ActionMenuOption = {
  label: string;
  testID: string;
  destructive?: boolean;
  onPress: () => void;
};

type Props = {
  testID: string;
  visible: boolean;
  title?: string;
  options: ActionMenuOption[];
  onDismiss: () => void;
};

/** ActionSheetIOS on iOS; iOS-styled bottom sheet on web/Android. */
export function ActionMenu({ testID, visible, title, options, onDismiss }: Props) {
  useEffect(() => {
    if (Platform.OS !== "ios" || !visible) return;
    const labels = options.map((o) => o.label);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...labels, "Cancel"],
        cancelButtonIndex: labels.length,
        destructiveButtonIndex: options.findIndex((o) => o.destructive),
      },
      (index) => {
        onDismiss();
        if (index == null || index >= options.length) return;
        options[index]?.onPress();
      },
    );
  }, [visible, title, options, onDismiss]);

  if (Platform.OS === "ios" || !visible) return null;

  return (
    <Modal testID={testID} transparent animationType="slide" visible={visible} onRequestClose={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onDismiss}>
        <View style={styles.sheet}>
          {title ? (
            <Text testID={`${testID}-title`} style={styles.title}>
              {title}
            </Text>
          ) : null}
          {options.map((opt) => (
            <Pressable
              key={opt.testID}
              testID={opt.testID}
              style={styles.row}
              onPress={() => {
                opt.onPress();
                onDismiss();
              }}
            >
              <Text
                testID={`${opt.testID}-label`}
                style={[styles.rowLabel, opt.destructive && styles.destructive]}
              >
                {opt.label}
              </Text>
            </Pressable>
          ))}
          <Pressable testID={`${testID}-cancel`} style={styles.cancel} onPress={onDismiss}>
            <Text testID={`${testID}-cancel-label`} style={styles.cancelLabel}>
              Cancel
            </Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: colors.groupedBackground,
    padding: spacing.md,
    gap: spacing.sm,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  title: {
    ...typeScale.footnote,
    color: colors.secondaryLabel,
    textAlign: "center",
    marginBottom: spacing.xs,
  },
  row: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  rowLabel: { ...typeScale.body, fontWeight: "600" },
  destructive: { color: colors.danger as string },
  cancel: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.xs,
  },
  cancelLabel: { ...typeScale.body, fontWeight: "600" },
});

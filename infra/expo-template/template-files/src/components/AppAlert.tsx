import { useEffect } from "react";
import { Alert, Modal, Platform, StyleSheet, Text, View } from "react-native";
import { AppButton } from "./AppButton";
import { colors, layout, radius, spacing, type as typeScale } from "../theme/tokens";

type Button = { text: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void };

type Props = {
  testID: string;
  visible: boolean;
  title: string;
  message?: string;
  buttons: Button[];
  onDismiss: () => void;
};

/** Native Alert on iOS/Android; iOS-styled modal on web. */
export function AppAlert({ testID, visible, title, message, buttons, onDismiss }: Props) {
  useEffect(() => {
    if (Platform.OS === "web" || !visible) return;
    Alert.alert(
      title,
      message,
      buttons.map((b) => ({
        text: b.text,
        style: b.style,
        onPress: () => {
          b.onPress?.();
          onDismiss();
        },
      })),
      { cancelable: true, onDismiss },
    );
  }, [visible, title, message, buttons, onDismiss]);

  if (Platform.OS !== "web" || !visible) return null;

  return (
    <Modal testID={testID} transparent animationType="fade" visible={visible} onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text testID={`${testID}-title`} style={styles.title}>
            {title}
          </Text>
          {message ? (
            <Text testID={`${testID}-message`} style={styles.message}>
              {message}
            </Text>
          ) : null}
          <View style={styles.actions}>
            {buttons.map((b, i) => (
              <AppButton
                key={b.text}
                label={b.text}
                testID={`${testID}-btn-${i}`}
                variant={b.style === "destructive" ? "danger" : "secondary"}
                onPress={() => {
                  b.onPress?.();
                  onDismiss();
                }}
              />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Imperative helper for simple native alerts outside React state. */
export function showAppAlert(title: string, message: string | undefined, buttons: Button[]): void {
  Alert.alert(title, message, buttons);
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    padding: layout.marginHorizontal,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    width: "100%",
    maxWidth: 320,
    gap: spacing.sm,
  },
  title: { ...typeScale.headline, textAlign: "center" },
  message: { ...typeScale.body, color: colors.secondaryLabel, textAlign: "center" },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
});

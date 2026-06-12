import type { ReactNode } from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { colors, layout, radius, spacing } from "../theme/tokens.js";

type Props = {
  testID: string;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
};

/** Native pageSheet on iOS; iOS-styled sheet on web. */
export function Sheet({ testID, visible, onClose, children }: Props) {
  return (
    <Modal
      testID={testID}
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      transparent={Platform.OS === "web"}
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grabber} />
          <View testID={`${testID}-content`} style={styles.content}>
            {children}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: Platform.OS === "web" ? "flex-end" : "center",
    backgroundColor: Platform.OS === "web" ? "rgba(0,0,0,0.4)" : "transparent",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingBottom: spacing.lg,
    maxHeight: Platform.OS === "web" ? "85%" : undefined,
    flex: Platform.OS === "web" ? undefined : 1,
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.separator as string,
    alignSelf: "center",
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  content: { paddingHorizontal: layout.marginHorizontal },
});

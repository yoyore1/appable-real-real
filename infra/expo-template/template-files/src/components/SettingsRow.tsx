import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { hapticLight } from "../lib/haptics.js";
import { colors, layout, type as typeScale } from "../theme/tokens.js";

type Props = {
  testID: string;
  label: string;
  value?: string;
  onPress?: () => void;
  showChevron?: boolean;
  isLast?: boolean;
};

/** Settings-style row — 44pt min, inset separator, optional chevron. */
export function SettingsRow({
  testID,
  label,
  value,
  onPress,
  showChevron,
  isLast = false,
}: Props) {
  const chevron = showChevron ?? Boolean(onPress);

  const inner = (
    <>
      <View style={styles.rowInner}>
        <Text testID={`${testID}-label`} style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <View style={styles.right}>
          {value ? (
            <Text testID={`${testID}-value`} style={styles.value} numberOfLines={1}>
              {value}
            </Text>
          ) : null}
          {chevron ? (
            <View testID={`${testID}-chevron`}>
              <Ionicons name="chevron-forward" size={16} color={colors.tertiaryLabel as string} />
            </View>
          ) : null}
        </View>
      </View>
      {!isLast ? <View style={styles.separator} /> : null}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={() => {
          void hapticLight();
          onPress();
        }}
        style={styles.row}
      >
        {inner}
      </Pressable>
    );
  }

  return (
    <View testID={testID} style={styles.row}>
      {inner}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: layout.rowMinHeight, justifyContent: "center" },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: layout.rowMinHeight,
    paddingHorizontal: layout.marginHorizontal,
  },
  label: { ...typeScale.body, flex: 1, marginRight: 8 },
  right: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  value: { ...typeScale.body, color: colors.secondaryLabel },
  separator: {
    height: layout.hairline,
    backgroundColor: colors.separator,
    marginLeft: layout.separatorInset,
  },
});

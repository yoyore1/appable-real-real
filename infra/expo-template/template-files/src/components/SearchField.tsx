import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radius, spacing, type as typeScale } from "../theme/tokens";

type Props = {
  testID: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
};

/** iOS-style search field with Cancel on focus. */
export function SearchField({ testID, value, onChangeText, placeholder = "Search" }: Props) {
  const [focused, setFocused] = useState(false);

  return (
    <View testID={testID} style={styles.wrap}>
      <View style={styles.field}>
        <Ionicons name="search" size={18} color={colors.secondaryLabel as string} />
        <TextInput
          testID={`${testID}-input`}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.secondaryLabel as string}
          style={styles.input}
          onFocus={() => setFocused(true)}
          onBlur={() => !value && setFocused(false)}
          returnKeyType="search"
        />
      </View>
      {focused ? (
        <Pressable
          testID={`${testID}-cancel`}
          onPress={() => {
            onChangeText("");
            setFocused(false);
          }}
          style={styles.cancel}
        >
          <Text testID={`${testID}-cancel-label`} style={styles.cancelLabel}>
            Cancel
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  field: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.searchFill,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    minHeight: 36,
  },
  input: {
    flex: 1,
    ...typeScale.body,
    paddingVertical: spacing.sm,
    color: colors.label as string,
  },
  cancel: { paddingHorizontal: spacing.xs, minHeight: 36, justifyContent: "center" },
  cancelLabel: { ...typeScale.body, color: colors.primary as string, fontWeight: "600" },
});

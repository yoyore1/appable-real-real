import { useState } from "react";
import { LayoutAnimation, Platform, Pressable, StyleSheet, Text, UIManager, View } from "react-native";
import { hapticSelection } from "../lib/haptics.js";
import { colors, radius, spacing, type as typeScale } from "../theme/tokens.js";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export type SegmentOption = { id: string; label: string; testID: string };

type Props = {
  testID: string;
  options: SegmentOption[];
  value: string;
  onChange: (id: string) => void;
};

/** iOS-style segmented control — pill in grey track. */
export function SegmentedControl({ testID, options, value, onChange }: Props) {
  const [trackWidth, setTrackWidth] = useState(0);
  const index = Math.max(0, options.findIndex((o) => o.id === value));
  const segmentWidth = trackWidth > 0 ? trackWidth / options.length : 0;

  return (
    <View
      testID={testID}
      style={styles.track}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
    >
      {segmentWidth > 0 ? (
        <View
          style={[
            styles.thumb,
            {
              width: segmentWidth - 4,
              transform: [{ translateX: index * segmentWidth + 2 }],
            },
          ]}
        />
      ) : null}
      {options.map((opt) => {
        const selected = opt.id === value;
        return (
          <Pressable
            key={opt.id}
            testID={opt.testID}
            style={styles.segment}
            onPress={() => {
              if (opt.id === value) return;
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              void hapticSelection();
              onChange(opt.id);
            }}
          >
            <Text
              testID={`${opt.testID}-label`}
              style={[styles.label, selected && styles.labelSelected]}
              numberOfLines={1}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    backgroundColor: colors.searchFill,
    borderRadius: radius.sm,
    padding: 2,
    minHeight: 32,
  },
  thumb: {
    position: "absolute",
    top: 2,
    bottom: 2,
    backgroundColor: colors.surface,
    borderRadius: radius.sm - 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
  },
  segment: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: spacing.xs },
  label: { ...typeScale.footnote, color: colors.label, fontWeight: "400" },
  labelSelected: { fontWeight: "600" },
});

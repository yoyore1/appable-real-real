import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { Platform, StyleSheet, View, type ViewProps } from "react-native";

type Props = ViewProps & {
  testID?: string;
  children: ReactNode;
  intensity?: number;
};

/** Real blur on iOS; translucent fallback on web/Android. */
export function Blur({ children, testID, intensity = 60, style, ...rest }: Props) {
  if (Platform.OS === "ios") {
    return (
      <BlurView testID={testID} intensity={intensity} tint="systemChromeMaterial" style={[styles.blur, style]} {...rest}>
        {children}
      </BlurView>
    );
  }

  return (
    <View testID={testID} style={[styles.fallback, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  blur: { overflow: "hidden" },
  fallback: { backgroundColor: "rgba(255,255,255,0.85)" },
});

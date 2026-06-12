import type { ComponentType } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Platform, View, type ViewProps } from "react-native";

type Props = ViewProps & {
  testID: string;
  symbol?: string;
  ionicon: keyof typeof Ionicons.glyphMap;
  size?: number;
  color?: string;
};

type SymbolViewProps = { name: string; size: number; tintColor?: string; testID?: string };

let SymbolView: ComponentType<SymbolViewProps> | null = null;
if (Platform.OS === "ios") {
  try {
    SymbolView = require("expo-symbols").SymbolView as ComponentType<SymbolViewProps>;
  } catch {
    SymbolView = null;
  }
}

/** SF Symbol on iOS when available; Ionicons elsewhere. */
export function AppIcon({ testID, symbol, ionicon, size = 22, color, style, ...rest }: Props) {
  if (SymbolView && symbol) {
    return (
      <View testID={testID} style={style} {...rest}>
        <SymbolView name={symbol} size={size} tintColor={color} testID={`${testID}-symbol`} />
      </View>
    );
  }

  return (
    <View testID={testID} style={style} {...rest}>
      <Ionicons name={ionicon} size={size} color={color} />
    </View>
  );
}

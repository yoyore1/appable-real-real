import "../appable-bridge.js";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { TapEditProvider } from "../src/lib/tapEdit";

/** Platform-owned root layout — agent must not edit. */
export default function RootLayout() {
  return (
    <TapEditProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="(stack)" />
      </Stack>
    </TapEditProvider>
  );
}

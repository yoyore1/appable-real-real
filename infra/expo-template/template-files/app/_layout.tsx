import "../appable-bridge.js";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

/** Platform-owned root layout — agent must not edit. */
export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="(stack)" />
      </Stack>
    </>
  );
}

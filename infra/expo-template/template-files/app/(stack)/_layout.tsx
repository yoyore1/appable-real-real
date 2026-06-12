import { Stack } from "expo-router";

/** Platform-owned stack for secondary screens (habits, detail, legal, etc.). */
export default function StackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

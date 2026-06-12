import { Text } from "react-native";
import { Screen } from "../../src/components/Screen";

/** Agent replaces or extends this settings route. */
export default function SettingsRoute() {
  return (
    <Screen testID="settings-screen" title="Settings" largeTitle scroll>
      <Text testID="settings-placeholder">Settings</Text>
    </Screen>
  );
}

import { Text } from "react-native";
import { Screen } from "../../src/components/Screen";

/** Agent replaces this scaffold with the real home route content. */
export default function HomeRoute() {
  return (
    <Screen testID="home-screen" title="Home" largeTitle scroll>
      <Text testID="home-welcome">Welcome — your app loads here.</Text>
    </Screen>
  );
}

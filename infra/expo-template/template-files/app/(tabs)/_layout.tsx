import { Tabs } from "expo-router";
import { BottomTabBar, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Platform, View } from "react-native";
import { EditableIcon } from "../../src/components";
import { colors } from "../../src/theme/tokens";

/** Platform-owned tab shell — icon colors are editable via tap-to-edit. */
function AppTabBar(props: BottomTabBarProps) {
  const bar = <BottomTabBar {...props} />;
  if (Platform.OS === "web") {
    return (
      <View data-appable="non-editable" testID="main-tab-bar">
        {bar}
      </View>
    );
  }
  return bar;
}

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <AppTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => (
            <EditableIcon
              testID="home-tab-icon"
              name="home-outline"
              size={size}
              source={{ file: "src/theme/tokens.ts", export: "colors", property: "primary" }}
              defaultValue={{ color }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <EditableIcon
              testID="settings-tab-icon"
              name="settings-outline"
              size={size}
              source={{ file: "src/theme/tokens.ts", export: "colors", property: "primary" }}
              defaultValue={{ color }}
            />
          ),
        }}
      />
    </Tabs>
  );
}

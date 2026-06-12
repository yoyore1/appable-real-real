import { normalizeAppLayout, APP_LAYOUT_PATH } from "./platformGlue.js";

export { APP_LAYOUT_PATH };
export const TABS_LAYOUT_PATH = "app/(tabs)/_layout.tsx";
export const STACK_LAYOUT_PATH = "app/(stack)/_layout.tsx";

/** Only these routes belong in the tab bar. Everything else is stack-only. */
export const TAB_BAR_ROUTES = new Set(["index", "settings"]);

const TABS_PREFIX = "app/(tabs)/";
const STACK_PREFIX = "app/(stack)/";

export interface ProjectFileOps {
  listProjectFiles: (projectId: string) => Promise<string[]>;
  readProjectFile: (projectId: string, path: string) => Promise<string>;
  writeProjectFile: (projectId: string, path: string, content: string) => Promise<void>;
  deleteProjectFile: (projectId: string, path: string) => Promise<void>;
}

/** Agent tried to add a tab-bar route — send it to the stack group instead. */
export function redirectRogueTabWrite(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm.startsWith(TABS_PREFIX)) return norm;
  const rel = norm.slice(TABS_PREFIX.length);
  if (rel === "_layout.tsx" || rel === "_layout.jsx") return norm;
  if (!/\.(tsx|jsx)$/.test(rel)) return norm;
  const routeName = rel.replace(/\.(tsx|jsx)$/, "");
  if (routeName === "index" || routeName === "settings") return norm;
  return `${STACK_PREFIX}${rel}`;
}

function routeNameFromTabsFile(filePath: string): string | null {
  if (!filePath.startsWith(TABS_PREFIX)) return null;
  const rel = filePath.slice(TABS_PREFIX.length);
  if (rel === "_layout.tsx" || rel === "_layout.jsx") return null;
  if (!/\.(tsx|jsx)$/.test(rel)) return null;
  return rel.replace(/\.(tsx|jsx)$/, "");
}

/** Discover Expo Router screen names registered under app/(tabs)/. */
export async function listTabsScreenNames(
  projectId: string,
  listFiles: (projectId: string) => Promise<string[]>,
): Promise<string[]> {
  const files = await listFiles(projectId);
  const names = new Set<string>();
  for (const file of files) {
    const name = routeNameFromTabsFile(file);
    if (name) names.add(name);
  }
  return [...names].sort();
}

export function generateTabsLayoutContent(extraHiddenRoutes: string[] = []): string {
  const hidden = new Set(
    extraHiddenRoutes.filter((n) => !TAB_BAR_ROUTES.has(n) && n !== "index"),
  );

  const hiddenLines = [...hidden]
    .sort()
    .map(
      (name) =>
        `      <Tabs.Screen name="${name.replace(/"/g, '\\"')}" options={{ href: null }} />`,
    )
    .join("\n");

  return `import { Tabs } from "expo-router";
import { BottomTabBar, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { Platform, View } from "react-native";
import { colors } from "../../src/theme/tokens";

/** Platform-owned tab shell — only Home + Settings are visible tabs. */
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
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
${hiddenLines ? `${hiddenLines}\n` : ""}    </Tabs>
  );
}
`;
}

export function generateStackLayoutContent(): string {
  return `import { Stack } from "expo-router";

/** Platform-owned stack for secondary screens (habits, detail, legal, etc.). */
export default function StackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
`;
}

export function normalizeRootLayoutForStack(content: string): string {
  const body = normalizeAppLayout(content);
  if (/name=["']\(stack\)["']/.test(body)) return body;

  const stackScreen = `        <Stack.Screen name="(stack)" />`;
  const tabsScreen = body.match(/<Stack\.Screen name=["']\(tabs\)["'][^/]*\/>/);
  if (tabsScreen) {
    return body.replace(tabsScreen[0], `${tabsScreen[0]}\n${stackScreen}`);
  }
  return body;
}

/** Move rogue tab routes into app/(stack)/ so they don't appear in the tab bar. */
export async function migrateRogueTabRoutes(
  projectId: string,
  ops: ProjectFileOps,
): Promise<string[]> {
  const moved: string[] = [];
  const files = await ops.listProjectFiles(projectId);
  for (const file of [...files].sort()) {
    if (!file.startsWith(TABS_PREFIX)) continue;
    if (file === TABS_LAYOUT_PATH) continue;
    const routeName = routeNameFromTabsFile(file);
    if (!routeName || TAB_BAR_ROUTES.has(routeName)) continue;

    const dest = `${STACK_PREFIX}${file.slice(TABS_PREFIX.length)}`;
    const content = await ops.readProjectFile(projectId, file);
    await ops.writeProjectFile(projectId, dest, content);
    await ops.deleteProjectFile(projectId, file);
    moved.push(`${file} → ${dest}`);
  }
  return moved;
}

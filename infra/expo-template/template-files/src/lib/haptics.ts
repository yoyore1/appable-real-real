import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

/** Light haptic on button press — no-op on web. */
export async function hapticLight(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    /* simulator / unsupported */
  }
}

export async function hapticSelection(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await Haptics.selectionAsync();
  } catch {
    /* ignore */
  }
}

export async function hapticSuccess(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    /* ignore */
  }
}

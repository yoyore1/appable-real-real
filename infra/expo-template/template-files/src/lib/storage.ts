import AsyncStorage from "@react-native-async-storage/async-storage";

/** One storage key per app — JSON-serialize the whole state object. */
export const APP_DATA_KEY = "appdata";

export async function loadAppData<T>(fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(APP_DATA_KEY);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function saveAppData<T>(data: T): Promise<void> {
  await AsyncStorage.setItem(APP_DATA_KEY, JSON.stringify(data));
}

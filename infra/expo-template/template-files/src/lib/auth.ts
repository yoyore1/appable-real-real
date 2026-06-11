import AsyncStorage from "@react-native-async-storage/async-storage";

const SESSION_KEY = "appable:session";
const DATA_KEY = "appdata";

export type UserSession = {
  id: string;
  displayName: string;
  email: string;
  /** Set when audienceRoles has 2+ types */
  role?: string;
};

export async function loadSession(): Promise<UserSession | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserSession;
  } catch {
    return null;
  }
}

export async function saveSession(session: UserSession): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function signIn(input: {
  displayName: string;
  email: string;
  role?: string;
}): Promise<UserSession> {
  const session: UserSession = {
    id: `user-${Date.now()}`,
    displayName: input.displayName.trim() || "Guest",
    email: input.email.trim() || "guest@appable.local",
    role: input.role,
  };
  await saveSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
}

/** Wipes session and app user data — required on every Appable app. */
export async function deleteAccount(): Promise<void> {
  await AsyncStorage.multiRemove([SESSION_KEY, DATA_KEY]);
}

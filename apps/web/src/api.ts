const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const GUEST_DOMAIN = "guest.appable.dev";

export function getToken(): string | null {
  return localStorage.getItem("appable_token");
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem("appable_token", token);
  else localStorage.removeItem("appable_token");
}

export function getUserEmail(): string | null {
  return localStorage.getItem("appable_email");
}

export function setUserEmail(email: string | null): void {
  if (email) localStorage.setItem("appable_email", email);
  else localStorage.removeItem("appable_email");
}

/** True when the current session is an anonymous guest (pre-signup). */
export function isGuest(): boolean {
  const email = getUserEmail();
  return !email || email.endsWith(`@${GUEST_DOMAIN}`);
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const hasBody = opts.body !== undefined;
  // Fastify rejects POST/PUT/PATCH with Content-Type: application/json and an empty body.
  const body =
    hasBody ? JSON.stringify(opts.body) : method !== "GET" && method !== "HEAD" ? "{}" : undefined;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = data as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** Make sure we have *some* token - creates an anonymous guest session if not. */
export async function ensureSession(): Promise<void> {
  if (getToken()) return;
  const res = await api<{ token: string; user: { email: string } }>("/auth/guest", {
    method: "POST",
  });
  setToken(res.token);
  setUserEmail(res.user.email);
}

export function wsUrl(projectId: string): string {
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/ws?projectId=${encodeURIComponent(projectId)}&token=${encodeURIComponent(getToken() ?? "")}`;
}

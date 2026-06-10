import { useState } from "react";
import type { Route } from "../App.js";
import { api, getToken, setToken, setUserEmail } from "../api.js";

export function SignUp({ go, projectId }: { go: (r: Route) => void; projectId: string }) {
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        const res = await api<{ token: string; user: { email: string } }>("/auth/claim", {
          method: "POST",
          body: { email, password },
        });
        setToken(res.token);
        setUserEmail(res.user.email);
      } else {
        // Logging into an existing account: bring the interview project along.
        const guestToken = getToken();
        const res = await api<{ token: string; user: { email: string } }>("/auth/login", {
          method: "POST",
          body: { email, password, guestToken, transferProjectId: projectId },
        });
        setToken(res.token);
        setUserEmail(res.user.email);
      }
      const project = await api<{ paidAt: string | null }>(`/projects/${projectId}`);
      go(project.paidAt ? { name: "overview", projectId } : { name: "pay", projectId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div className="flow-page">
      <nav className="topnav">
        <span className="logo" onClick={() => go({ name: "home" })}>
          <span className="logo-dot" /> Appable
        </span>
        <span className="stepper">
          <span className="step-dash on" />
          <span className="step-dash on" />
          <span className="step-dash" />
          Save your app
        </span>
      </nav>

      <div className="flow-body">
        <div className="center-card rise">
          <h2>{mode === "signup" ? "It's almost real." : "Welcome back"}</h2>
          <p className="lead">
            {mode === "signup"
              ? "Your app plan is done. Create an account so it's saved and waiting for you — then we build."
              : "Log in and we'll bring your new app plan into your account."}
          </p>
          <input
            type="email"
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            placeholder="Choose a password (6+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {error && <p className="error-text">{error}</p>}
          <button
            className="btn btn-primary btn-big"
            onClick={submit}
            disabled={busy || !email.includes("@") || password.length < 6}
          >
            {busy ? "One moment" : mode === "signup" ? "Save my app" : "Log in"}
          </button>
          <button
            className="btn-link"
            onClick={() => setMode(mode === "signup" ? "login" : "signup")}
          >
            {mode === "signup" ? "Already have an account? Log in" : "New here? Create an account"}
          </button>
        </div>
      </div>
    </div>
  );
}

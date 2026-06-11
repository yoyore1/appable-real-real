import { useEffect, useState } from "react";
import type { Route } from "../App.js";
import { api } from "../api.js";

interface ProjectInfo {
  name: string;
  paidAt: string | null;
  specs: { data: { name?: string; tagline?: string } }[];
}

export function Pay({ go, projectId }: { go: (r: Route) => void; projectId: string }) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ProjectInfo>(`/projects/${projectId}`).then((p) => {
      if (p.paidAt) go({ name: "overview", projectId });
      else setProject(p);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const appName = project?.specs?.[0]?.data?.name ?? project?.name ?? "your app";

  async function pay() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${projectId}/pay`, { method: "POST" });
      void api(`/projects/${projectId}/spec/ensure`, { method: "POST" });
      go({ name: "overview", projectId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed - try again");
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
          <span className="step-dash on" />
          Start the build
        </span>
      </nav>

      <div className="flow-body">
        <div className="center-card rise">
          <h2>Bring {appName} to life</h2>
          <p className="lead">One dollar. That's the whole build — and you get to watch it happen.</p>

          <div className="price-row">
            <span className="price-big">$1</span>
            <span className="muted small">one time</span>
          </div>

          <ul className="perk-list">
            <li>
              <span className="perk-check">—</span> Your app, built and running in minutes
            </li>
            <li>
              <span className="perk-check">—</span> Works on your real phone, not just a demo
            </li>
            <li>
              <span className="perk-check">—</span> Change anything afterwards, just by asking
            </li>
            <li>
              <span className="perk-check">—</span> Privacy policy, terms and support page
              included
            </li>
          </ul>

          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-primary btn-big" onClick={pay} disabled={busy || !project}>
            {busy ? "Processing" : "Start the build · $1"}
          </button>
          <div className="trust-row">
            <span>Test mode — no card needed yet</span>
          </div>
        </div>
      </div>
    </div>
  );
}

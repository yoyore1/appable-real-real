import { useEffect, useState } from "react";
import type { Route } from "../App.js";
import { api, getUserEmail, setToken, setUserEmail } from "../api.js";

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  paidAt: string | null;
  updatedAt: string;
  specs?: { data: { name?: string } }[];
}

export function MyApps({ go }: { go: (r: Route) => void }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<ProjectRow[]>("/projects")
      .then((rows) => {
        setProjects(rows);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Could not load your apps";
        setLoadError(message);
        setProjects([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function open(p: ProjectRow) {
    if (["running", "building", "sleeping", "error"].includes(p.status)) {
      go({ name: "build", projectId: p.id });
    } else if (p.status === "spec_ready") {
      go(p.paidAt ? { name: "overview", projectId: p.id } : { name: "pay", projectId: p.id });
    } else {
      go({ name: "interview", projectId: p.id });
    }
  }

  function logout() {
    setToken(null);
    setUserEmail(null);
    localStorage.removeItem("appable_route");
    go({ name: "home" });
  }

  return (
    <div className="flow-page">
      <nav className="topnav">
        <span className="logo" onClick={() => go({ name: "home" })}>
          <span className="logo-dot" /> Appable
        </span>
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="muted small">{getUserEmail()}</span>
          <button className="btn btn-ghost" onClick={logout}>
            Log out
          </button>
        </span>
      </nav>

      <div className="flow-body">
        <div className="apps-wrap">
          <h1 className="apps-title rise">Your apps</h1>
          <p className="apps-sub rise d1">Pick up right where you left off.</p>
          <div className="apps-grid rise d2">
            <button className="app-card new-app-card" onClick={() => go({ name: "home" })}>
              New app
            </button>
            {projects === null && !loadError && <p className="muted">Loading your apps</p>}
            {loadError && (
              <div className="app-card" style={{ cursor: "default" }}>
                <b>Could not reach Appable</b>
                <span className="muted small">{loadError}</span>
                <span className="muted small">
                  Make sure the API is running on port 4000, then refresh this page.
                </span>
              </div>
            )}
            {projects?.map((p) => (
              <button key={p.id} className="app-card" onClick={() => open(p)}>
                <b>{p.specs?.[0]?.data?.name ?? p.name}</b>
                <span className={`badge badge-${p.status}`} style={{ alignSelf: "flex-start" }}>
                  {p.status === "running"
                    ? "Live"
                    : p.status === "sleeping"
                      ? "Paused"
                      : p.status === "spec_ready"
                        ? "Ready to build"
                        : p.status === "building"
                          ? "Building"
                          : p.status === "error"
                            ? "Needs attention"
                            : "Draft"}
                </span>
                <span className="muted small">
                  Updated {new Date(p.updatedAt).toLocaleDateString()}
                </span>
              </button>
            ))}
            {projects?.length === 0 && <p className="muted">No apps yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

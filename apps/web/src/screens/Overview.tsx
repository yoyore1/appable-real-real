import { useEffect, useState } from "react";
import type { AppSpec } from "@appable/shared";
import type { Route } from "../App.js";
import { api } from "../api.js";
import { useProjectSocket } from "../useProjectSocket.js";

interface ProjectInfo {
  name: string;
  status: string;
  paidAt: string | null;
  specs: { data: AppSpec }[];
}

function monogram(name: string): string {
  return (name.trim()[0] ?? "A").toUpperCase();
}

export function Overview({ go, projectId }: { go: (r: Route) => void; projectId: string }) {
  const s = useProjectSocket(projectId);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ title: string; body: string } | null>(null);

  // Load project metadata and kick spec generation if the interview finished
  // while the user was on signup / pay (events are not replayed over WS).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const p = await api<ProjectInfo>(`/projects/${projectId}`);
      if (cancelled) return;
      setProject(p);
      if (p.specs?.length) return;

      void api<{ ready: boolean; spec: AppSpec | null }>(
        `/projects/${projectId}/spec/ensure`,
        { method: "POST" },
      )
        .then((res) => {
          if (cancelled) return;
          if (res.spec) {
            setProject((prev) =>
              prev
                ? {
                    ...prev,
                    name: res.spec!.name,
                    status: "spec_ready",
                    specs: [{ data: res.spec! }],
                  }
                : prev,
            );
          } else if (!res.ready) {
            setPlanError("We couldn't finish your app plan. Try refreshing in a moment.");
          }
        })
        .catch(() => {
          if (!cancelled) setPlanError("Having trouble loading your app plan.");
        });
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Keep polling until the spec lands (covers slow model calls).
  useEffect(() => {
    if (project?.specs?.length || s.spec) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      const p = await api<ProjectInfo>(`/projects/${projectId}`);
      if (cancelled) return;
      setProject(p);
    }, 1200);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [project?.specs?.length, s.spec, projectId]);

  const spec = s.spec ?? project?.specs?.[0]?.data;
  const planning =
    !spec &&
    (s.agentStatus?.status === "planning" ||
      s.agentStatus?.message?.toLowerCase().includes("plan"));

  if (!project) {
    return (
      <div className="flow-page">
        <nav className="topnav">
          <span className="logo" onClick={() => go({ name: "home" })}>
            <span className="logo-dot" /> Appable
          </span>
        </nav>
        <div className="flow-body">
          <p className="muted" style={{ marginTop: 80 }}>
            Loading your app
          </p>
        </div>
      </div>
    );
  }

  const alreadyBuilt = ["running", "sleeping", "building"].includes(project.status);
  const displayName = spec?.name ?? project.name;

  return (
    <div className="flow-page">
      <nav className="topnav">
        <span className="logo" onClick={() => go({ name: "home" })}>
          <span className="logo-dot" /> Appable
        </span>
        <button className="btn btn-ghost" onClick={() => go({ name: "apps" })}>
          My apps
        </button>
      </nav>

      <div className="flow-body">
        <div className="overview">
          <div className="overview-hero">
            <p className="eyebrow rise">Meet your app</p>
            <div className="app-emoji rise d1">{monogram(displayName)}</div>
            <h1 className="rise d1">{displayName}</h1>
            {spec ? (
              <>
                <p className="tagline rise d2">{spec.tagline}</p>
                <p className="overview-desc rise d2">{spec.description}</p>
              </>
            ) : (
              <p className="tagline rise d2 muted">
                {planning
                  ? "Putting your app plan together…"
                  : "Almost there — loading your app plan…"}
              </p>
            )}
          </div>

          {spec ? (
            <>
              <div className="section-label rise d3">Your screens</div>
              <div className="screen-grid rise d3">
                {spec.screens.map((screen) => (
                  <div key={screen.name} className="screen-card">
                    <b>{screen.name}</b>
                    <span>{screen.purpose}</span>
                  </div>
                ))}
              </div>

              {spec.features.length > 0 && (
                <>
                  <div className="section-label">What it does</div>
                  <div className="feature-chips">
                    {spec.features.map((f) => (
                      <span key={f} className="feature-chip">
                        {f}
                      </span>
                    ))}
                  </div>
                </>
              )}

              {spec.legal && (
                <>
                  <div className="section-label">Included, written for you</div>
                  <div className="legal-row">
                    <button
                      className="legal-card"
                      onClick={() => setDoc({ title: "Privacy Policy", body: spec.legal!.privacy })}
                    >
                      <span className="legal-icon" />
                      <span>
                        <b>Privacy policy</b>
                        <span>Written for {spec.name}</span>
                      </span>
                    </button>
                    <button
                      className="legal-card"
                      onClick={() => setDoc({ title: "Terms of Service", body: spec.legal!.terms })}
                    >
                      <span className="legal-icon" />
                      <span>
                        <b>Terms of service</b>
                        <span>Short and readable</span>
                      </span>
                    </button>
                    <button
                      className="legal-card"
                      onClick={() => setDoc({ title: "Support", body: spec.legal!.support })}
                    >
                      <span className="legal-icon" />
                      <span>
                        <b>Support page</b>
                        <span>Help for your users</span>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="overview-skeleton rise d3">
              <div className="screen-card overview-skeleton-line" />
              <div className="screen-card overview-skeleton-line" />
              <div className="screen-card overview-skeleton-line" />
            </div>
          )}

          {planError && !spec && <p className="error-text rise">{planError}</p>}

          <div className="overview-cta">
            <button
              className="btn btn-primary btn-big"
              disabled={!spec}
              onClick={() =>
                go({ name: "build", projectId, autostart: !alreadyBuilt })
              }
            >
              {alreadyBuilt ? "Open my app" : "Bring it to life"}
            </button>
            <p className="muted small" style={{ marginTop: 14 }}>
              {alreadyBuilt
                ? "Your app is already built. Jump back in."
                : spec
                  ? "Takes a few minutes — and you get to watch every second."
                  : "Your plan usually appears in a few seconds."}
            </p>
          </div>
        </div>
      </div>

      {doc && (
        <div className="modal-overlay" onClick={() => setDoc(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {doc.title}
              <button className="icon-btn" onClick={() => setDoc(null)} title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">{doc.body}</div>
          </div>
        </div>
      )}
    </div>
  );
}

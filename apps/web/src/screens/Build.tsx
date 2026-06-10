import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { AppSpec } from "@appable/shared";
import type { Route } from "../App.js";
import { api } from "../api.js";
import { useProjectSocket, type ChatItem } from "../useProjectSocket.js";
import { useChatScroll } from "../useChatScroll.js";

interface ProjectDetail {
  id: string;
  name: string;
  status: string;
  paidAt: string | null;
  preview: { webUrl: string; expUrl: string } | null;
  specs: { data: AppSpec }[];
  checkpoints?: { id: string }[];
}

interface DbMessage {
  id: string;
  role: string;
  content: string;
}

/** Element info reported by the edit bridge inside the preview iframe. */
interface TappedElement {
  testId: string | null;
  text: string;
  tag: string;
  color: string;
  backgroundColor: string;
  fontSize: string;
}

function rgbToHex(rgb: string): string {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return "#000000";
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

function isTransparent(rgb: string): boolean {
  return rgb === "rgba(0, 0, 0, 0)" || rgb === "transparent";
}

export function Build({
  go,
  projectId,
  autostart,
}: {
  go: (r: Route) => void;
  projectId: string;
  autostart?: boolean;
}) {
  const s = useProjectSocket(projectId);
  const [tab, setTab] = useState<"build" | "brainstorm">("build");
  const [input, setInput] = useState("");
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const startedBuild = useRef(false);
  const wokeUp = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);

  // --- tap-to-edit state ---
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [editOn, setEditOn] = useState(false);
  const [tapped, setTapped] = useState<TappedElement | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftColor, setDraftColor] = useState("#000000");
  const [draftBg, setDraftBg] = useState("#ffffff");

  function postToPreview(msg: object) {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }

  function setEditMode(on: boolean) {
    setEditOn(on);
    setTapped(null);
    postToPreview({ type: "appable:edit-mode", on });
  }

  // Receive taps from the bridge inside the iframe.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data as { type?: string; el?: TappedElement };
      if (msg?.type === "appable:tapped" && msg.el) {
        setTapped(msg.el);
        setDraftText(msg.el.text);
        setDraftColor(rgbToHex(msg.el.color));
        setDraftBg(isTransparent(msg.el.backgroundColor) ? "#ffffff" : rgbToHex(msg.el.backgroundColor));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function applyTapEdit() {
    if (!tapped) return;
    const changes: string[] = [];
    const newText = draftText.trim();

    if (tapped.text && newText && newText !== tapped.text.trim()) {
      postToPreview({ type: "appable:apply", prop: "text", value: newText });
      changes.push(`set the text to "${newText}"`);
    }
    if (draftColor !== rgbToHex(tapped.color)) {
      postToPreview({ type: "appable:apply", prop: "color", value: draftColor });
      changes.push(`set the text color to ${draftColor}`);
    }
    const origBg = isTransparent(tapped.backgroundColor) ? "#ffffff" : rgbToHex(tapped.backgroundColor);
    if (draftBg !== origBg) {
      postToPreview({ type: "appable:apply", prop: "background", value: draftBg });
      changes.push(`set the background color to ${draftBg}`);
    }
    if (changes.length === 0) {
      closeTapPanel();
      return;
    }

    const target = tapped.testId
      ? `the element with testID "${tapped.testId}"`
      : `the ${tapped.tag} element with current text "${tapped.text.slice(0, 80)}"`;
    const message = `[Tap edit] In the app, find ${target} and ${changes.join("; ")}. Change only this element.`;

    s.appendLocal("build", message);
    s.send({ type: "chat.send", conversation: "build", text: message });
    closeTapPanel();
  }

  function closeTapPanel() {
    setTapped(null);
    postToPreview({ type: "appable:clear" });
  }

  useEffect(() => {
    api<ProjectDetail>(`/projects/${projectId}`).then((p) => {
      setProject(p);
      setCanUndo((p.checkpoints?.length ?? 0) >= 2);
    });
    for (const kind of ["brainstorm", "build"] as const) {
      api<DbMessage[]>(`/projects/${projectId}/messages?kind=${kind}`).then((msgs) =>
        s.seed(
          kind,
          msgs.map(
            (m): ChatItem => ({
              id: m.id,
              role: m.role === "user" ? "user" : "assistant",
              text: m.content,
            }),
          ),
        ),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Refresh undo availability when a new checkpoint is saved.
  useEffect(() => {
    if (!s.checkpointsVersion) return;
    api<ProjectDetail>(`/projects/${projectId}`).then((p) => {
      setCanUndo((p.checkpoints?.length ?? 0) >= 2);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.checkpointsVersion]);

  const status = s.projectStatus ?? project?.status ?? "new";
  const spec = s.spec ?? project?.specs?.[0]?.data ?? null;
  const preview = s.preview?.status === "ready" ? s.preview : null;
  const webUrl = preview?.webUrl ?? project?.preview?.webUrl ?? null;
  const expUrl = preview?.expUrl ?? project?.preview?.expUrl ?? null;
  const building = status === "building";

  // Auto-wake a sleeping/stale workspace (app already exists, container off).
  useEffect(() => {
    if (!project || wokeUp.current || building) return;
    const hasSpec = (project.specs?.length ?? 0) > 0;
    if (hasSpec && !project.preview && ["sleeping", "running", "error"].includes(project.status)) {
      wokeUp.current = true;
      setStarting(true);
      api(`/projects/${projectId}/start`, { method: "POST" })
        .then(() => api<ProjectDetail>(`/projects/${projectId}`))
        .then(setProject)
        .finally(() => setStarting(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // Autostart the first build when arriving from the overview screen.
  useEffect(() => {
    if (autostart && s.connected && !startedBuild.current && status === "spec_ready") {
      startedBuild.current = true;
      s.send({ type: "build.start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart, s.connected, status]);

  const agentBusy =
    s.agentStatus && !["idle", "done", "failed"].includes(s.agentStatus.status);

  function sendChat() {
    const text = input.trim();
    if (!text) return;
    const conversation = tab === "brainstorm" ? ("brainstorm" as const) : ("build" as const);
    s.appendLocal(conversation, text);
    s.send({ type: "chat.send", conversation, text });
    setInput("");
  }

  async function undo() {
    if (undoBusy || !canUndo || agentBusy || building) return;
    setUndoBusy(true);
    setEditMode(false);
    try {
      const res = await api<{ ok: boolean; canUndo: boolean }>(`/projects/${projectId}/undo`, {
        method: "POST",
      });
      setCanUndo(res.canUndo);
      setIframeKey((k) => k + 1);
    } catch {
      // Agent status line shows errors from the API when undo fails.
    } finally {
      setUndoBusy(false);
    }
  }

  return (
    <div className="build-page">
      <header className="build-topbar">
        <button className="btn btn-ghost" onClick={() => go({ name: "apps" })}>
          My apps
        </button>
        <h1>{spec?.name ?? project?.name ?? "Your app"}</h1>
        <span className={`badge badge-${status}`}>{statusLabel(status)}</span>
        <span className="muted small" style={{ marginLeft: "auto" }}>
          {s.connected ? (
            <>
              <span className="live-dot" />
              live
            </>
          ) : (
            "connecting..."
          )}
        </span>
      </header>

      <div className="build-cols">
        {/* ---------- left: brainstorm / build ---------- */}
        <section className="bcol bcol-left">
          <div className="seg">
            <button className={tab === "build" ? "on" : ""} onClick={() => setTab("build")}>
              Build
            </button>
            <button
              className={tab === "brainstorm" ? "on" : ""}
              onClick={() => setTab("brainstorm")}
            >
              Brainstorm
            </button>
          </div>

          {tab === "build" ? (
            building || (s.buildLog.length > 0 && s.build.length === 0) ? (
              <ActivityFeed
                log={s.buildLog}
                statusLine={s.agentStatus?.message}
              />
            ) : (
              <ChatPane
                items={s.build}
                empty={'Ask for any change, in plain words. "Make the buttons bigger." "Add a dark mode." It happens in the phone on the right.'}
              />
            )
          ) : (
            <ChatPane
              items={s.brainstorm}
              empty="Think out loud about your app here. Features, names, what to add next."
            />
          )}

          <div className="chat-inputbar" style={{ marginTop: 10 }}>
            <input
              value={input}
              placeholder={
                tab === "brainstorm"
                  ? "Ask anything about your app"
                  : building
                    ? "Still building, one moment"
                    : "Describe a change"
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChat()}
              disabled={tab === "build" && building}
            />
            <button
              className="send-btn"
              onClick={sendChat}
              disabled={!input.trim() || (tab === "build" && building)}
            >
              <SendIcon />
            </button>
          </div>
        </section>

        {/* ---------- middle: phone ---------- */}
        <section className="bcol bcol-mid">
          <div className="phone-toolbar">
            <div className={s.agentStatus?.status === "done" ? "agent-line done" : "agent-line"}>
              {agentBusy && <span className="spin" />}
              {s.agentStatus?.status === "done"
                ? "It's alive. Go play with it."
                : s.agentStatus?.message ?? "\u00a0"}
            </div>
            {webUrl && !building && (
              <div className="phone-toolbar-actions">
                <button
                  className="btn btn-ghost edit-toggle"
                  onClick={undo}
                  disabled={!canUndo || undoBusy || Boolean(agentBusy)}
                  title={canUndo ? "Undo your last change" : "Nothing to undo yet"}
                >
                  {undoBusy ? "Undoing…" : "Undo"}
                </button>
                <button
                  className={editOn ? "btn btn-primary edit-toggle" : "btn btn-ghost edit-toggle"}
                  onClick={() => setEditMode(!editOn)}
                >
                  {editOn ? "Done editing" : "Tap to edit"}
                </button>
              </div>
            )}
          </div>
          {editOn && !tapped && (
            <p className="muted small edit-hint">Tap anything in your app to change it.</p>
          )}
          <div className={editOn ? "phone phone-editing" : "phone"}>
            <div className="phone-notch" />
            {webUrl ? (
              <iframe
                key={iframeKey}
                title="Your app"
                src={webUrl}
                ref={iframeRef}
                onLoad={() => postToPreview({ type: "appable:edit-mode", on: editOn })}
              />
            ) : (
              <div className="phone-empty-state">
                {starting ? (
                  <>
                    <b>Waking your app</b>
                    <span className="small">about ten seconds</span>
                  </>
                ) : building ? (
                  <>
                    <b>Your app is being born</b>
                    <span className="small">it shows up right here as it takes shape</span>
                  </>
                ) : (
                  <>
                    <b>Your app will appear here</b>
                    {status === "spec_ready" && (
                      <button
                        className="btn btn-primary"
                        onClick={() => s.send({ type: "build.start" })}
                      >
                        Build my app
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          {building && (
            <button className="btn btn-ghost" onClick={() => s.send({ type: "build.cancel" })}>
              Cancel build
            </button>
          )}
          {tapped && (
            <div className="edit-panel">
              <div className="edit-panel-head">
                <b>{tapped.testId ?? (tapped.text ? `"${tapped.text.slice(0, 32)}"` : "Element")}</b>
                <button className="btn-link" onClick={closeTapPanel}>
                  Cancel
                </button>
              </div>
              {tapped.text && (
                <label className="edit-field">
                  <span>Text</span>
                  <input value={draftText} onChange={(e) => setDraftText(e.target.value)} />
                </label>
              )}
              <div className="edit-colors">
                <label className="edit-field">
                  <span>Text color</span>
                  <input
                    type="color"
                    value={draftColor}
                    onChange={(e) => setDraftColor(e.target.value)}
                  />
                </label>
                <label className="edit-field">
                  <span>Background</span>
                  <input
                    type="color"
                    value={draftBg}
                    onChange={(e) => setDraftBg(e.target.value)}
                  />
                </label>
              </div>
              <button className="btn btn-primary" onClick={applyTapEdit}>
                Apply change
              </button>
              <p className="muted small" style={{ margin: 0, textAlign: "center" }}>
                Shows instantly, saves in the background.
              </p>
            </div>
          )}
        </section>

        {/* ---------- right: phone install / plan / checklist ---------- */}
        <section className="bcol bcol-right">
          <div className="side-card">
            <h3>On your phone</h3>
            {expUrl ? (
              <>
                <div className="qr-row">
                  <QrBlock value={expUrl} />
                  <ol className="expo-steps">
                    <li>
                      Get the free <b>Expo Go</b> app from the App Store or Google Play
                    </li>
                    <li>Scan this code with your phone camera</li>
                    <li>Your app opens, for real</li>
                  </ol>
                </div>
                <code className="exp-url">{expUrl}</code>
              </>
            ) : (
              <p className="muted small">
                Your QR code appears here once your app is running.
              </p>
            )}
          </div>

          {spec && (
            <div className="side-card">
              <h3>App plan</h3>
              <div className="plan-screens">
                {spec.screens.map((screen) => (
                  <div key={screen.name} className="plan-screen">
                    <b>{screen.name}</b>
                    <br />
                    <span>{screen.purpose}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="side-card">
            <h3>Next steps</h3>
            <ul className="check-list">
              <ChecklistItem done label="Tell us your idea" />
              <ChecklistItem done={Boolean(spec)} label="App plan created" />
              <ChecklistItem
                done={["running", "sleeping"].includes(status)}
                label="App built"
              />
              <ChecklistItem done={false} label="Try it on your phone" />
              <ChecklistItem done={false} label="Ask for your first change" />
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Live";
    case "building":
      return "Building";
    case "sleeping":
      return "Paused";
    case "spec_ready":
      return "Ready to build";
    case "error":
      return "Needs attention";
    default:
      return status;
  }
}

function ChecklistItem({ done, label }: { done: boolean; label: string }) {
  return (
    <li>
      {done ? <span className="check-on">✓</span> : <span className="check-off" />}
      {label}
    </li>
  );
}

function ChatPane({ items, empty }: { items: ChatItem[]; empty: string }) {
  const scrollTail = items
    .map((m) => `${m.id}:${m.text.length}:${m.streaming ? 1 : 0}`)
    .join("|");
  const ref = useChatScroll(scrollTail);
  return (
    <div className="chat-scroll" ref={ref} style={{ flex: 1 }}>
      {items.length === 0 && <p className="muted small">{empty}</p>}
      {items.map((m) => (
        <div key={m.id} className={`imsg ${m.role === "user" ? "me" : "them"}`}>
          {m.text.trim()}
          {m.streaming ? "▌" : ""}
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({
  log,
  statusLine,
}: {
  log: { level: string; source: string; text: string }[];
  statusLine?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log, statusLine]);
  return (
    <div className="activity" ref={ref}>
      {log.length === 0 && <p className="muted small">Build activity will appear here...</p>}
      {log.map((e, i) => (
        <div key={i} className={`act-line${e.level === "error" ? " err" : ""}`}>
          <span className="act-icon">{iconFor(e)}</span>
          <span>{e.text.length > 220 ? `${e.text.slice(0, 220)}...` : e.text}</span>
        </div>
      ))}
    </div>
  );
}

function iconFor(e: { level: string; source: string; text: string }): string {
  if (e.level === "error") return "!";
  if (e.text.startsWith("wrote ")) return "+";
  if (e.text.startsWith("deleted ")) return "\u2212";
  if (e.source === "agent") return "\u203a";
  return "\u00b7";
}

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function QrBlock({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(value, { width: 232, margin: 1 }).then(setDataUrl);
  }, [value]);
  return dataUrl ? <img className="qr-img" src={dataUrl} alt="Scan with Expo Go" /> : null;
}

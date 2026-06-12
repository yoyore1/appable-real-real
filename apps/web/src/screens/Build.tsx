import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { AppSpec } from "@appable/shared";
import type { Route } from "../App.js";
import { api } from "../api.js";
import { useProjectSocket, type ChatItem } from "../useProjectSocket.js";
import { useChatScroll } from "../useChatScroll.js";
import { useBuildProgress } from "../useBuildProgress.js";
import {
  formatBuildChatDisplay,
  friendlyBuildLogLine,
  friendlyBuildStatus,
  friendlyTapEditMessage,
} from "../buildCopy.js";
import { MicButton } from "../components/MicButton.js";
import { HoverTip } from "../components/HoverTip.js";
import { SidePanel } from "../components/SidePanel.js";
import {
  ChatAttachButton,
  type PendingAttachment,
} from "../components/ChatAttachButton.js";
import { ChatAttachmentThumb } from "../components/ChatAttachmentThumb.js";
import { parseChatMessage, uploadChatAttachment } from "../chatAttachments.js";
import {
  TAP_FONT_CSS,
  TAP_FONT_OPTIONS,
  fontPresetFromComputed,
  fontPresetLabel,
  isBoldWeight,
  type TapFontPreset,
} from "../tapEditStyle.js";

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
interface TappedTextPart {
  text: string;
  isIcon?: boolean;
}

interface TappedElement {
  testId: string | null;
  /** testID on the tapped text label */
  textTestId?: string | null;
  /** testID on the card/box around the tap */
  boxTestId?: string | null;
  /** Short label for scoping background edits (e.g. "Tue") */
  anchorLabel?: string;
  text: string;
  textParts?: TappedTextPart[];
  tag: string;
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontWeight: string;
  fontFamily: string;
  /** True when the tap hit empty padding — background color only. */
  backgroundOnly?: boolean;
}

function shortTapLabel(text: string | undefined): string {
  if (!text) return "";
  const line = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > 48 ? line.slice(0, 48) : line;
}

/** Stat/session/goal cards — not the full page background. */
function isCardBoxTestId(id: string | null | undefined): boolean {
  if (!id) return false;
  return /^(stat-|recent-session-|home-goal-|session-|goal-)/.test(id);
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
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachUploading, setAttachUploading] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const startedBuild = useRef(false);
  const wokeUp = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [previewNonce, setPreviewNonce] = useState(0);

  // --- tap-to-edit state ---
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [editOn, setEditOn] = useState(false);
  const [tapped, setTapped] = useState<TappedElement | null>(null);
  const [draftTexts, setDraftTexts] = useState<string[]>([]);
  const [originalTexts, setOriginalTexts] = useState<string[]>([]);
  const [partIsIcon, setPartIsIcon] = useState<boolean[]>([]);
  const [draftColor, setDraftColor] = useState("#000000");
  const [draftBg, setDraftBg] = useState("#ffffff");
  const [draftBold, setDraftBold] = useState(false);
  const [originalBold, setOriginalBold] = useState(false);
  const [draftFont, setDraftFont] = useState<TapFontPreset>("sans");
  const [originalFont, setOriginalFont] = useState<TapFontPreset>("sans");
  const [pendingEditNotice, setPendingEditNotice] = useState(false);

  function postToPreview(msg: object) {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }

  function hasPendingTapEdits(): boolean {
    if (!tapped) return false;
    if (tapped.backgroundOnly) {
      const origBg = isTransparent(tapped.backgroundColor)
        ? "#ffffff"
        : rgbToHex(tapped.backgroundColor);
      return draftBg !== origBg;
    }
    for (let i = 0; i < draftTexts.length; i++) {
      if ((draftTexts[i] ?? "") !== (originalTexts[i] ?? "")) return true;
    }
    if (draftColor !== rgbToHex(tapped.color)) return true;
    const origBg = isTransparent(tapped.backgroundColor)
      ? "#ffffff"
      : rgbToHex(tapped.backgroundColor);
    if (draftBg !== origBg) return true;
    if (draftBold !== originalBold) return true;
    if (draftFont !== originalFont) return true;
    return false;
  }

  function exitEditMode(revertPreview: boolean) {
    setPendingEditNotice(false);
    setEditOn(false);
    setTapped(null);
    setPartIsIcon([]);
    if (revertPreview) postToPreview({ type: "appable:clear" });
    postToPreview({ type: "appable:edit-mode", on: false });
  }

  function requestExitEditMode() {
    if (hasPendingTapEdits()) {
      setPendingEditNotice(true);
      return;
    }
    exitEditMode(Boolean(tapped));
  }

  function setEditMode(on: boolean) {
    if (!on) {
      requestExitEditMode();
      return;
    }
    setPendingEditNotice(false);
    setEditOn(true);
    // Wake container + repair tap-to-edit bridge, then reload preview bundle.
    void api(`/projects/${projectId}/start`, { method: "POST" }).catch(() => {});
    setIframeKey((k) => k + 1);
  }

  // Receive taps from the bridge inside the iframe.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data as { type?: string; el?: TappedElement };
      if (msg?.type === "appable:tapped" && msg.el) {
        const backgroundOnly =
          Boolean(msg.el.backgroundOnly) ||
          (Array.isArray(msg.el.textParts) && msg.el.textParts.length === 0);
        const parts = backgroundOnly
          ? []
          : msg.el.textParts && msg.el.textParts.length > 0
            ? msg.el.textParts.map((p) => p.text)
            : msg.el.text
              ? [msg.el.text]
              : [];
        setPendingEditNotice(false);
        setTapped({ ...msg.el, backgroundOnly });
        setDraftTexts(parts);
        setOriginalTexts(parts);
        setPartIsIcon(
          msg.el.textParts?.map((p) => Boolean(p.isIcon)) ?? parts.map(() => false),
        );
        setDraftColor(rgbToHex(msg.el.color));
        setDraftBg(isTransparent(msg.el.backgroundColor) ? "#ffffff" : rgbToHex(msg.el.backgroundColor));
        const bold = isBoldWeight(msg.el.fontWeight ?? "400");
        setDraftBold(bold);
        setOriginalBold(bold);
        const font = fontPresetFromComputed(msg.el.fontFamily ?? "");
        setDraftFont(font);
        setOriginalFont(font);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function applyTapEdit() {
    if (!tapped) return;
    const changes: string[] = [];
    const partUpdates: { index: number; value: string }[] = [];
    const bgAnchor = shortTapLabel(tapped.anchorLabel ?? "");
    const screenBg = tapped.backgroundOnly && !isCardBoxTestId(tapped.boxTestId);
    const label =
      originalTexts.find((t, i) => !partIsIcon[i] && t.trim())?.trim() ||
      bgAnchor ||
      shortTapLabel(tapped.text);

    for (let i = 0; i < draftTexts.length; i++) {
      const next = draftTexts[i] ?? "";
      const prev = originalTexts[i] ?? "";
      if (next === prev) continue;
      partUpdates.push({ index: i, value: next });
      if (!next.trim() && partIsIcon[i]) {
        changes.push(
          label
            ? `remove the icon from the container for "${label}"`
            : `remove the icon from this element`,
        );
      } else {
        changes.push(`replace the text "${prev}" with "${next}"`);
      }
    }
    if (partUpdates.length > 0) {
      postToPreview({ type: "appable:apply-parts", parts: partUpdates });
    }
    if (!tapped.backgroundOnly && draftColor !== rgbToHex(tapped.color)) {
      postToPreview({ type: "appable:apply", prop: "color", value: draftColor });
      changes.push(
        label
          ? `set the text color of "${label}" to ${draftColor}`
          : `set the text color to ${draftColor}`,
      );
    }
    const origBg = isTransparent(tapped.backgroundColor) ? "#ffffff" : rgbToHex(tapped.backgroundColor);
    if (draftBg !== origBg) {
      postToPreview({ type: "appable:apply", prop: "background", value: draftBg });
      if (tapped.backgroundOnly) {
        if (screenBg) {
          changes.push(`set the screen background color to ${draftBg}`);
        } else if (tapped.boxTestId) {
          changes.push(`set the background color to ${draftBg}`);
        } else if (bgAnchor) {
          changes.push(`set the background color of the container for "${bgAnchor}" to ${draftBg}`);
        } else {
          changes.push(`set the screen background color to ${draftBg}`);
        }
      } else {
        changes.push(
          label
            ? `set the background color of the container for "${label}" to ${draftBg}`
            : `set the background color to ${draftBg}`,
        );
      }
    }
    if (!tapped.backgroundOnly && draftBold !== originalBold) {
      const weight = draftBold ? "700" : "400";
      postToPreview({ type: "appable:apply", prop: "fontWeight", value: weight });
      const weightWord = draftBold ? "bold" : "normal";
      changes.push(
        label
          ? `set the font weight of "${label}" to ${weightWord}`
          : `set the font weight to ${weightWord}`,
      );
    }
    if (!tapped.backgroundOnly && draftFont !== originalFont) {
      const cssFont = TAP_FONT_CSS[draftFont];
      postToPreview({ type: "appable:apply", prop: "fontFamily", value: cssFont });
      const fontLabel = fontPresetLabel(draftFont);
      changes.push(
        label
          ? `set the font family of "${label}" to ${fontLabel}`
          : `set the font family to ${fontLabel}`,
      );
    }
    if (changes.length === 0) {
      closeTapPanel();
      return;
    }

    const hasBg = draftBg !== origBg;
    const hasColor = draftColor !== rgbToHex(tapped.color);
    const hasText = partUpdates.length > 0;
    const hasFont = draftBold !== originalBold || draftFont !== originalFont;
    const target =
      tapped.backgroundOnly && screenBg
        ? `the main screen background`
        : tapped.backgroundOnly && tapped.boxTestId
          ? `the element with testID "${tapped.boxTestId}"`
          : tapped.backgroundOnly && bgAnchor
            ? `the card container for "${bgAnchor}"`
            : hasText && tapped.textTestId
        ? `the element with testID "${tapped.textTestId}"`
        : (hasColor || hasFont) && !hasBg && tapped.textTestId
          ? `the element with testID "${tapped.textTestId}"`
          : hasColor && hasBg && tapped.boxTestId
            ? `the element with testID "${tapped.boxTestId}"`
            : hasColor && tapped.boxTestId
              ? `the element with testID "${tapped.boxTestId}"`
              : hasBg && tapped.boxTestId
                ? `the element with testID "${tapped.boxTestId}"`
                : hasBg && tapped.textTestId
                  ? `the element with testID "${tapped.textTestId}"`
                  : hasFont && tapped.textTestId
                    ? `the element with testID "${tapped.textTestId}"`
                    : hasBg && label
                      ? `the card container for "${label}"`
                      : tapped.textTestId
                        ? `the element with testID "${tapped.textTestId}"`
                        : label
                          ? `the ${tapped.tag} element showing "${label}"`
                          : `the ${tapped.tag} element`;
    const message = `[Tap edit] In the app, find ${target} and ${changes.join("; ")}. Change only what was tapped.`;

    s.appendLocal("build", friendlyTapEditMessage(changes));
    s.send({ type: "chat.send", conversation: "build", text: message });
    setOriginalBold(draftBold);
    setOriginalFont(draftFont);
    setPendingEditNotice(false);
    hideTapPanel();
    window.setTimeout(() => postToPreview({ type: "appable:clear-outline" }), 50);
  }

  function updateDraftText(index: number, value: string) {
    setDraftTexts((prev) => prev.map((t, i) => (i === index ? value : t)));
    postToPreview({ type: "appable:apply-parts", parts: [{ index, value }] });
  }

  function updateDraftBold(bold: boolean) {
    setDraftBold(bold);
    postToPreview({ type: "appable:apply", prop: "fontWeight", value: bold ? "700" : "400" });
  }

  function updateDraftFont(preset: TapFontPreset) {
    setDraftFont(preset);
    postToPreview({ type: "appable:apply", prop: "fontFamily", value: TAP_FONT_CSS[preset] });
  }

  function hideTapPanel() {
    setTapped(null);
    setPartIsIcon([]);
  }

  function closeTapPanel() {
    setPendingEditNotice(false);
    hideTapPanel();
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
          msgs.map((m): ChatItem => {
            const parsed = parseChatMessage(m.content);
            const displayText =
              kind === "build" && m.role === "user"
                ? formatBuildChatDisplay(parsed.text)
                : parsed.text;
            return {
              id: m.id,
              role: m.role === "user" ? "user" : "assistant",
              text: displayText,
              ...(parsed.attachments.length ? { attachments: parsed.attachments } : {}),
            };
          }),
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

  const status = reconcileProjectStatus(s.projectStatus, project?.status);
  const spec = s.spec ?? project?.specs?.[0]?.data ?? null;
  const livePreview = s.preview?.status === "ready" ? s.preview : project?.preview;
  const baseWebUrl = livePreview?.webUrl ?? null;
  const webUrl =
    baseWebUrl && previewNonce > 0
      ? `${baseWebUrl}${baseWebUrl.includes("?") ? "&" : "?"}_r=${previewNonce}`
      : baseWebUrl;
  const expUrl = livePreview?.expUrl ?? null;
  const previewStarting = starting || s.preview?.status === "starting";
  const building = status === "building";
  const previewReady = s.preview?.status === "ready" || Boolean(project?.preview?.webUrl);
  /** Hide the empty template early in build; show live Metro once the bundle exists. */
  const showPreview =
    Boolean(webUrl) &&
    (!building || previewReady) &&
    (status === "running" || status === "sleeping" || building);
  const buildProgress = useBuildProgress({
    active: building,
    agentStatus: s.agentStatus,
    buildLog: s.buildLog,
    previewReady,
    expectedScreens: spec?.screens.length,
  });

  // Keep project detail fresh while building — WS/DB can lag after build finishes.
  useEffect(() => {
    if (!building) return;
    let cancelled = false;
    const refresh = () => {
      api<ProjectDetail>(`/projects/${projectId}`).then((p) => {
        if (!cancelled) setProject(p);
      });
    };
    refresh();
    const id = window.setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [building, projectId]);

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

  // Autostart the first build when arriving from pay / overview.
  useEffect(() => {
    if (!autostart || !s.connected || startedBuild.current) return;

    const tryStart = (projectStatus: string) => {
      if (projectStatus === "spec_ready" && !startedBuild.current) {
        startedBuild.current = true;
        s.send({ type: "build.start" });
        return true;
      }
      return false;
    };

    if (tryStart(status)) return;

    let cancelled = false;
    void (async () => {
      for (let i = 0; i < 80; i++) {
        if (cancelled || startedBuild.current) return;
        const p = await api<{ status: string }>(`/projects/${projectId}`);
        if (tryStart(p.status)) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart, s.connected, status, projectId]);

  const agentBusy =
    s.agentStatus && !["idle", "done", "failed"].includes(s.agentStatus.status);

  async function addAttachments(files: File[]) {
    if (!files.length) return;
    setAttachError(null);
    setAttachUploading(true);
    try {
      for (const file of files) {
        const uploaded = await uploadChatAttachment(projectId, file);
        const previewUrl = URL.createObjectURL(file);
        setPendingAttachments((prev) => [
          ...prev,
          { ...uploaded, previewUrl },
        ]);
      }
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setAttachUploading(false);
    }
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((prev) => {
      const hit = prev.find((a) => a.id === id);
      if (hit) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }

  function sendChat() {
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || attachUploading) return;
    const conversation = tab === "brainstorm" ? ("brainstorm" as const) : ("build" as const);
    const messageText = text || "See attached image";
    const attachments = pendingAttachments.map(({ id, name, mime, url }) => ({
      id,
      name,
      mime,
      url,
    }));
    s.appendLocal(
      conversation,
      messageText,
      attachments.length ? attachments : undefined,
    );
    s.send({
      type: "chat.send",
      conversation,
      text: messageText,
      ...(attachments.length ? { attachments } : {}),
    });
    setInput("");
    for (const a of pendingAttachments) URL.revokeObjectURL(a.previewUrl);
    setPendingAttachments([]);
    setAttachError(null);
  }

  async function undo() {
    if (undoBusy || !canUndo || agentBusy || building) return;
    setUndoBusy(true);
    exitEditMode(true);
    try {
      const res = await api<{ ok: boolean; canUndo: boolean }>(`/projects/${projectId}/undo`, {
        method: "POST",
      });
      setCanUndo(res.canUndo);
      setPreviewNonce((n) => n + 1);
      setIframeKey((k) => k + 1);
    } catch {
      // Agent status line shows errors from the API when undo fails.
    } finally {
      setUndoBusy(false);
    }
  }

  const screenBgTap =
    tapped?.backgroundOnly && !isCardBoxTestId(tapped.boxTestId);

  return (
    <div className="build-page">
      <header className="build-topbar">
        <button className="btn btn-ghost" onClick={() => go({ name: "apps" })}>
          My apps
        </button>
        <h1>{spec?.name ?? project?.name ?? "Your app"}</h1>
        <span className={`badge badge-${status}`}>
          {statusLabel(status)}
          {building && buildProgress > 0 ? ` · ${buildProgress}%` : ""}
        </span>
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

      <div className={tapped ? "build-cols build-cols-tap-edit" : "build-cols"}>
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
            building ? (
              <ActivityFeed log={s.buildLog} friendly />
            ) : (
              <ChatPane
                items={s.build}
                empty={'Ask for any change, in plain words. "Make the buttons bigger." "Add a dark mode." It happens in the phone on the right.'}
              />
            )
          ) : (
            <ChatPane
              items={s.brainstorm}
              empty="Ask about your app — what's missing, what to prioritize, ideas for v2. I already know your plan and what's built."
            />
          )}

          <div className="chat-compose" style={{ marginTop: 10 }}>
            {attachError && <p className="chat-attach-error muted small">{attachError}</p>}
            {pendingAttachments.length > 0 && (
              <div className="chat-pending-attachments">
                {pendingAttachments.map((att) => (
                  <figure key={att.id} className="chat-pending-attach">
                    <img src={att.previewUrl} alt={att.name} title={att.name} />
                    <button
                      type="button"
                      className="chat-pending-remove"
                      aria-label={`Remove ${att.name}`}
                      onClick={() => removePendingAttachment(att.id)}
                    >
                      ×
                    </button>
                  </figure>
                ))}
              </div>
            )}
            <div className="chat-inputbar">
              <ChatAttachButton
                disabled={(tab === "build" && building) || attachUploading}
                count={pendingAttachments.length}
                onPick={(files) => void addAttachments(files)}
                onError={setAttachError}
              />
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
              <MicButton
                className="icon-btn chat-mic"
                tip="Describe a change out loud — we'll make it."
                disabled={tab === "build" && building}
                onTranscript={(chunk) =>
                  setInput((prev) => (prev ? `${prev.trim()} ${chunk}` : chunk))
                }
              />
              <button
                className="send-btn"
                onClick={sendChat}
                disabled={
                  attachUploading ||
                  (!input.trim() && pendingAttachments.length === 0) ||
                  (tab === "build" && building)
                }
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </section>

        {/* ---------- middle: phone ---------- */}
        <section className={tapped ? "bcol bcol-mid bcol-mid-tap-edit" : "bcol bcol-mid"}>
          <div className="phone-toolbar">
            <div className="phone-toolbar-main">
              <div className={s.agentStatus?.status === "done" ? "agent-line done" : "agent-line"}>
                {agentBusy && <span className="spin" />}
                {building
                  ? friendlyBuildStatus(s.agentStatus, buildProgress)
                  : s.agentStatus?.message?.trim() ||
                    (s.agentStatus?.status === "done" ? "Your app is ready." : "\u00a0")}
              </div>
              {building && (
                <div className="build-progress" aria-label={`Build progress ${buildProgress}%`}>
                  <div className="build-progress-track">
                    <div
                      className="build-progress-fill"
                      style={{ width: `${buildProgress}%` }}
                    />
                  </div>
                  <span className="build-progress-pct">{buildProgress}%</span>
                </div>
              )}
            </div>
            {showPreview && (
              <div className="phone-toolbar-actions">
                <HoverTip
                  text={
                    canUndo
                      ? "Go back to before your last change."
                      : "Nothing to undo yet."
                  }
                  delayMs={1000}
                >
                  <button
                    className="btn btn-ghost edit-toggle"
                    onClick={undo}
                    disabled={!canUndo || undoBusy || Boolean(agentBusy)}
                  >
                    {undoBusy ? "Undoing…" : "Undo"}
                  </button>
                </HoverTip>
                <HoverTip
                  text="Tap anything on your app to change its text or colors."
                  delayMs={1000}
                  wide
                >
                  <button
                    className={editOn ? "btn btn-primary edit-toggle" : "btn btn-ghost edit-toggle"}
                    onClick={() => (editOn ? requestExitEditMode() : setEditMode(true))}
                  >
                    {editOn ? "Done editing" : "Tap to edit"}
                  </button>
                </HoverTip>
              </div>
            )}
          </div>
          {pendingEditNotice && (
            <div className="edit-pending-notice" role="alert">
              <p>
                You have unsaved changes in the editor. Press <b>Apply change</b> to save them,
                or <b>Cancel</b> on the panel to discard.
              </p>
              <div className="edit-pending-notice-actions">
                <button className="btn btn-ghost" type="button" onClick={() => setPendingEditNotice(false)}>
                  Keep editing
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => exitEditMode(true)}
                >
                  Leave without saving
                </button>
              </div>
            </div>
          )}
          {editOn && !tapped && !pendingEditNotice && (
            <p className="muted small edit-hint">Tap anything in your app to change it.</p>
          )}
          <div className={tapped ? "phone-stage phone-stage-editing" : "phone-stage"}>
          {tapped && (
            <div className="edit-panel">
              <div className="edit-panel-head">
                <b>
                  {screenBgTap
                    ? "Screen background"
                    : tapped.backgroundOnly
                      ? "Background"
                      : shortTapLabel(tapped.anchorLabel ?? originalTexts[0] ?? tapped.text) ||
                      tapped.boxTestId ||
                      tapped.textTestId ||
                      "Element"}
                </b>
                <button className="btn-link" onClick={closeTapPanel}>
                  Cancel
                </button>
              </div>
              {draftTexts.length > 0 &&
                draftTexts.map((part, i) => (
                <label className="edit-field" key={`edit-part-${i}`}>
                  <span>
                    {partIsIcon[i]
                      ? "Icon"
                      : draftTexts.length > 1
                        ? originalTexts[i]?.slice(0, 28) || `Text ${i + 1}`
                        : "Text"}
                  </span>
                  <input
                    value={part}
                    onChange={(e) => updateDraftText(i, e.target.value)}
                  />
                </label>
              ))}
              {tapped.backgroundOnly && (
                <p className="muted small" style={{ margin: "0 0 8px" }}>
                  {screenBgTap
                    ? "This changes the whole page background. Tap a stat card to change just that card."
                    : "Tap text to change wording — empty areas edit background color only."}
                </p>
              )}
              {!tapped.backgroundOnly && (
              <div className="edit-font-row">
                <label className="edit-field">
                  <span>Font</span>
                  <select
                    value={draftFont}
                    onChange={(e) => updateDraftFont(e.target.value as TapFontPreset)}
                  >
                    {TAP_FONT_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="edit-field">
                  <span>Weight</span>
                  <div className="edit-bold-toggle">
                    <button
                      type="button"
                      className={draftBold ? "on" : ""}
                      onClick={() => updateDraftBold(true)}
                    >
                      Bold
                    </button>
                    <button
                      type="button"
                      className={!draftBold ? "on" : ""}
                      onClick={() => updateDraftBold(false)}
                    >
                      Normal
                    </button>
                  </div>
                </div>
              </div>
              )}
              <div className="edit-colors">
                {!tapped.backgroundOnly && (
                <label className="edit-field">
                  <span>Text color</span>
                  <input
                    type="color"
                    value={draftColor}
                    onChange={(e) => setDraftColor(e.target.value)}
                  />
                </label>
                )}
                <label className="edit-field">
                  <span>
                    {screenBgTap
                      ? "Page background color"
                      : tapped.backgroundOnly
                        ? "Background color"
                        : shortTapLabel(tapped.anchorLabel ?? originalTexts[0])
                          ? `${shortTapLabel(tapped.anchorLabel ?? originalTexts[0])} box background`
                          : "Box background"}
                  </span>
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
              <p className="muted small edit-panel-foot">
                Preview updates instantly. Wait for &quot;Change saved.&quot; before leaving.
              </p>
            </div>
          )}
          <div className={editOn ? "phone-device phone-editing" : "phone-device"}>
            <div className="phone-side phone-side-left" aria-hidden>
              <span className="phone-btn phone-btn-action" />
              <span className="phone-btn phone-btn-vol-up" />
              <span className="phone-btn phone-btn-vol-down" />
            </div>
            <div className="phone">
              <div className="phone-bezel">
                <div className="phone-screen">
                  <div className="phone-dynamic-island" aria-hidden />
                  {showPreview ? (
                    <iframe
                      key={iframeKey}
                      title="Your app"
                      src={webUrl!}
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
                          <div className="build-progress-ring" aria-hidden>
                            <svg viewBox="0 0 64 64">
                              <circle className="build-progress-ring-bg" cx="32" cy="32" r="28" />
                              <circle
                                className="build-progress-ring-fill"
                                cx="32"
                                cy="32"
                                r="28"
                                strokeDasharray={`${(buildProgress / 100) * 175.9} 175.9`}
                              />
                            </svg>
                            <span className="build-progress-ring-pct">{buildProgress}%</span>
                          </div>
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
              </div>
            </div>
            <div className="phone-side phone-side-right" aria-hidden>
              <span className="phone-btn phone-btn-power" />
            </div>
            <div className="phone-shadow" aria-hidden />
          </div>
          </div>
          {building && (
            <button className="btn btn-ghost" onClick={() => s.send({ type: "build.cancel" })}>
              Cancel build
            </button>
          )}
        </section>

        {/* ---------- right: phone install / plan / checklist ---------- */}
        <section className="bcol bcol-right">
          <SidePanel
            title="On your phone"
            autoOpenWhen={Boolean(expUrl && showPreview)}
            badge={expUrl && showPreview ? "Ready" : previewStarting ? "Starting…" : undefined}
          >
            {expUrl && showPreview ? (
              <div className="expo-panel">
                <QrBlock value={expUrl} size={168} />
                <ol className="expo-steps">
                  <li>
                    <span className="expo-step-num">1</span>
                    <span>
                      Get <b>Expo Go</b> free from the App Store or Google Play
                    </span>
                  </li>
                  <li>
                    <span className="expo-step-num">2</span>
                    <span>Open Expo Go and scan this code</span>
                  </li>
                  <li>
                    <span className="expo-step-num">3</span>
                    <span>Your app opens on your phone</span>
                  </li>
                </ol>
                <p className="expo-footnote muted small">
                  Phone must be on the <b>same Wi‑Fi</b> as this computer. If Expo Go times out,
                  open this page first (wakes Metro), wait for Ready, then scan again.
                </p>
                <p className="expo-footnote muted small">
                  Or paste this link in Expo Go if scanning is tricky
                </p>
                <code className="exp-url">{expUrl}</code>
              </div>
            ) : previewStarting && showPreview ? (
              <p className="muted small side-panel-empty">
                Starting Metro for your phone… about 10–20 seconds, then the QR appears.
              </p>
            ) : (
              <p className="muted small side-panel-empty">
                Your QR code shows up here once the build finishes and Metro is running.
              </p>
            )}
          </SidePanel>

          {spec && (
            <SidePanel
              title="App plan"
              badge={`${spec.screens.length} screens`}
              badgeTone="muted"
            >
              <div className="plan-screens">
                {spec.screens.map((screen) => (
                  <div key={screen.name} className="plan-screen">
                    <b>{screen.name}</b>
                    <span>{screen.purpose}</span>
                  </div>
                ))}
              </div>
            </SidePanel>
          )}

          <SidePanel title="Next steps">
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
          </SidePanel>
        </section>
      </div>
    </div>
  );
}

/** WS can lag behind the DB (e.g. missed project.status after build finishes). */
function reconcileProjectStatus(
  wsStatus: string | null | undefined,
  dbStatus: string | null | undefined,
): string {
  if (wsStatus === "building" && dbStatus === "running") return "running";
  return wsStatus ?? dbStatus ?? "new";
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
          {m.attachments && m.attachments.length > 0 && (
            <div className="chat-msg-attachments">
              {m.attachments.map((att) => (
                <ChatAttachmentThumb key={att.id} attachment={att} />
              ))}
            </div>
          )}
          {(m.role === "user" ? formatBuildChatDisplay(m.text) : m.text).trim()}
          {m.streaming ? "▌" : ""}
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({
  log,
  friendly = false,
}: {
  log: { level: string; source: string; text: string }[];
  friendly?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lines = friendly
    ? log
        .map((e) => friendlyBuildLogLine(e.text, e.source) ?? (e.level === "error" ? e.text : null))
        .filter((t): t is string => Boolean(t))
    : log.map((e) => e.text);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length, log.length]);

  return (
    <div className="activity" ref={ref}>
      {lines.length === 0 && (
        <p className="muted small">
          {friendly ? "Your app is taking shape..." : "Build activity will appear here..."}
        </p>
      )}
      {friendly
        ? lines.map((text, i) => (
            <div key={i} className="act-line">
              <span className="act-icon">✓</span>
              <span>{text}</span>
            </div>
          ))
        : log.map((e, i) => (
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

function QrBlock({ value, size = 110 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(value, { width: size, margin: 1 }).then(setDataUrl);
  }, [value, size]);
  return dataUrl ? (
    <img className="qr-img" style={{ width: size, height: size }} src={dataUrl} alt="Scan with Expo Go" />
  ) : null;
}

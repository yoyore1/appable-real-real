import { useEffect, useRef, useState } from "react";
import type { Route } from "../App.js";
import { api, isGuest } from "../api.js";
import { MicButton } from "../components/MicButton.js";
import { useProjectSocket } from "../useProjectSocket.js";
import { useChatScroll } from "../useChatScroll.js";

interface DbMessage {
  id: string;
  role: string;
  content: string;
}

const APPABLE_PICK = "Let Appable pick";
const GO_DEEPER = "Let's go deeper";
const START_BUILDING = "Start building";

export function Interview({
  go,
  projectId,
  idea,
}: {
  go: (r: Route) => void;
  projectId: string;
  idea?: string;
}) {
  const s = useProjectSocket(projectId);
  const [input, setInput] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const sentIdea = useRef(false);
  const advanced = useRef(false);
  const scrollTail =
    s.interview.map((m) => `${m.id}:${m.text.length}:${m.streaming ? 1 : 0}`).join("|") +
    `|w:${waiting ? 1 : 0}|s:${s.spec ? 1 : 0}`;
  const scrollRef = useChatScroll(scrollTail);

  // Load history (resume case), then auto-send the initial idea once.
  useEffect(() => {
    api<DbMessage[]>(`/projects/${projectId}/messages?kind=interview`).then((msgs) => {
      s.seed(
        "interview",
        msgs.map((m) => ({
          id: m.id,
          role: m.role === "user" ? ("user" as const) : ("assistant" as const),
          text: m.content,
        })),
      );
      if (msgs.length > 0) sentIdea.current = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Send the home-screen idea as the first message once the socket is live.
  useEffect(() => {
    if (s.connected && idea && !sentIdea.current) {
      sentIdea.current = true;
      s.appendLocal("interview", idea);
      s.send({ type: "chat.send", conversation: "interview", text: idea });
      setWaiting(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.connected, idea]);

  // Stop the typing indicator when the assistant starts replying.
  useEffect(() => {
    const last = s.interview[s.interview.length - 1];
    if (last?.role === "assistant") setWaiting(false);
  }, [s.interview]);

  // Fresh picks for each new question.
  useEffect(() => {
    setPicked([]);
  }, [s.interviewSuggestions?.messageId]);

  async function continueFlow() {
    if (isGuest()) {
      go({ name: "signup", projectId });
      return;
    }
    const project = await api<{ paidAt: string | null }>(`/projects/${projectId}`);
    go(project.paidAt ? { name: "overview", projectId } : { name: "pay", projectId });
  }

  async function startBuilding() {
    if (advanced.current || advancing) return;
    advanced.current = true;
    setAdvancing(true);
    s.clearInterviewSuggestions();
    setPicked([]);
    setInput("");

    try {
      await continueFlow();
    } catch {
      advanced.current = false;
      setAdvancing(false);
    }
  }

  function goDeeper() {
    advanced.current = false;
    sendAnswer(GO_DEEPER, { allowAfterSpec: true });
  }

  function sendAnswer(text: string, opts?: { allowAfterSpec?: boolean }) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const inWrapup = s.interviewSuggestions?.mode === "wrapup";
    if (s.spec && !opts?.allowAfterSpec && inWrapup) return;
    s.clearInterviewSuggestions();
    s.appendLocal("interview", trimmed);
    s.send({ type: "chat.send", conversation: "interview", text: trimmed });
    setInput("");
    setPicked([]);
    setWaiting(true);
  }

  function togglePick(item: string) {
    setPicked((prev) =>
      prev.includes(item) ? prev.filter((x) => x !== item) : [...prev, item],
    );
  }

  function pickForMe() {
    sendAnswer(APPABLE_PICK);
  }

  function send() {
    if (waiting) return;
    const wrapup = s.interviewSuggestions?.mode === "wrapup";
    if (input.trim()) {
      sendAnswer(input, wrapup ? { allowAfterSpec: true } : undefined);
      return;
    }
    if (picked.length > 0) {
      sendAnswer(picked.join(", "));
    }
  }

  const streaming = s.interview.some((m) => m.streaming);
  const suggestionId = s.interviewSuggestions?.messageId;
  const isWrapup = s.interviewSuggestions?.mode === "wrapup";
  const questionVisible = suggestionId
    ? s.interview.some((m) => m.id === suggestionId && m.role === "assistant")
    : false;
  const showSuggestions =
    Boolean(s.interviewSuggestions) &&
    questionVisible &&
    (!s.spec || isWrapup || s.interviewSuggestions?.mode === "answer");
  const canSend =
    Boolean(input.trim() || picked.length > 0) &&
    !waiting &&
    (!s.spec || isWrapup || s.interviewSuggestions?.mode === "answer");

  return (
    <div className="flow-page chat-flow">
      <nav className="topnav">
        <span className="logo" onClick={() => go({ name: "home" })}>
          <span className="logo-dot" /> Appable
        </span>
        <span className="stepper">
          <span className="step-dash on" />
          <span className="step-dash" />
          <span className="step-dash" />
          Getting to know your app
        </span>
      </nav>

      <div className="flow-body" style={{ minHeight: 0, flex: 1 }}>
        <div className="chat-wrap">
          <div className="chat-intro rise">
            <h2>Let's get to know your app.</h2>
            <p>A minute of friendly questions — then we build it.</p>
          </div>
          <div className="chat-scroll" ref={scrollRef}>
            {s.interview.map((m) => (
              <div key={m.id} className={`imsg ${m.role === "user" ? "me" : "them"}`}>
                {m.text.trim()}
              </div>
            ))}
            {waiting && !streaming && !showSuggestions && (
              <div className="typing">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            )}
            {s.spec && !showSuggestions && (
              <div className="spec-ready-card">
                <b>Your app plan is ready.</b>
                <span className="muted small">Here comes the fun part</span>
              </div>
            )}
          </div>

          <div className="chat-compose">
            {showSuggestions && s.interviewSuggestions && isWrapup && (
              <div className="suggest-panel suggest-wrapup" key={s.interviewSuggestions.messageId}>
                <p className="suggest-hint">Looks good?</p>
                <div className="suggest-row">
                  <button
                    type="button"
                    className="suggest-chip suggest-go"
                    style={{ animationDelay: "0ms" }}
                    onClick={() => void startBuilding()}
                  >
                    {advancing ? "On our way…" : START_BUILDING}
                  </button>
                  <button
                    type="button"
                    className="suggest-chip"
                    style={{ animationDelay: "35ms" }}
                    onClick={goDeeper}
                  >
                    {GO_DEEPER}
                  </button>
                </div>
              </div>
            )}

            {showSuggestions && s.interviewSuggestions && !isWrapup && (
              <div className="suggest-panel" key={s.interviewSuggestions.messageId}>
                <p className="suggest-hint">
                  {picked.length > 0
                    ? `${picked.length} selected · tap send when ready`
                    : "Pick any that fit — one, two, or all"}
                </p>
                <div className="suggest-row">
                  {s.interviewSuggestions.items.map((item, i) => {
                    const on = picked.includes(item);
                    return (
                      <button
                        key={`${item}-${i}`}
                        type="button"
                        className={on ? "suggest-chip on" : "suggest-chip"}
                        style={{ animationDelay: `${i * 35}ms` }}
                        onClick={() => togglePick(item)}
                        aria-pressed={on}
                      >
                        {on && <span className="suggest-check" aria-hidden />}
                        {item}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="suggest-chip suggest-pick"
                    style={{
                      animationDelay: `${s.interviewSuggestions.items.length * 35}ms`,
                    }}
                    onClick={pickForMe}
                  >
                    {APPABLE_PICK}
                  </button>
                </div>
              </div>
            )}

            <div className="chat-inputbar">
              <input
                value={input}
                placeholder={
                  isWrapup
                    ? "Or tell us what to change"
                    : picked.length > 0
                      ? "Or type your own answer"
                      : "Type your answer"
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && canSend && send()}
                disabled={waiting}
              />
              <MicButton
                className="icon-btn chat-mic"
                tip="Answer out loud — same as typing."
                disabled={waiting}
                onTranscript={(chunk) =>
                  setInput((prev) => (prev ? `${prev.trim()} ${chunk}` : chunk))
                }
              />
              <button className="send-btn" onClick={send} disabled={!canSend}>
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

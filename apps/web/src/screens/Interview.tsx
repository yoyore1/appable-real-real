import { useEffect, useRef, useState } from "react";
import type { Route } from "../App.js";
import { api, isGuest } from "../api.js";
import { useProjectSocket } from "../useProjectSocket.js";
import { useChatScroll } from "../useChatScroll.js";

interface DbMessage {
  id: string;
  role: string;
  content: string;
}

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
  const [waiting, setWaiting] = useState(false);
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

  // Stop the typing indicator when the assistant starts/finishes replying.
  useEffect(() => {
    const last = s.interview[s.interview.length - 1];
    if (last?.role === "assistant") setWaiting(false);
  }, [s.interview]);

  // Spec ready -> short pause so they read the summary, then continue the flow.
  useEffect(() => {
    if (!s.spec || advanced.current) return;
    advanced.current = true;
    const timer = setTimeout(async () => {
      if (isGuest()) {
        go({ name: "signup", projectId });
        return;
      }
      const project = await api<{ paidAt: string | null }>(`/projects/${projectId}`);
      go(project.paidAt ? { name: "overview", projectId } : { name: "pay", projectId });
    }, 2600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.spec]);

  function send() {
    const text = input.trim();
    if (!text || waiting) return;
    s.appendLocal("interview", text);
    s.send({ type: "chat.send", conversation: "interview", text });
    setInput("");
    setWaiting(true);
  }

  const streaming = s.interview.some((m) => m.streaming);

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
            {waiting && !streaming && (
              <div className="typing">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            )}
            {s.spec && (
              <div className="spec-ready-card">
                <b>Your app plan is ready.</b>
                <span className="muted small">Here comes the fun part</span>
              </div>
            )}
          </div>

          <div className="chat-inputbar">
            <input
              value={input}
              placeholder="Type your answer"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              disabled={Boolean(s.spec)}
            />
            <button className="send-btn" onClick={send} disabled={!input.trim() || Boolean(s.spec)}>
              <SendIcon />
            </button>
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

import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "../App.js";
import { api, ensureSession, getUserEmail, isGuest } from "../api.js";

const IDEA_POOL = [
  "A habit tracker that keeps me motivated with streaks",
  "An app for my dog walking business with bookings",
  "A meal planner that builds my grocery list",
  "A budget app that makes saving feel like a game",
  "A workout log for me and my gym buddies",
  "A plant care reminder so my plants stop dying",
  "A journal with daily prompts and moods",
  "A chore chart my kids actually want to use",
  "An inventory app for my small online shop",
  "A recipe box for my family's secret recipes",
  "A study planner with flash cards for exams",
  "A travel checklist that packs for any trip",
];

function pickThree(except: string[] = []): string[] {
  const pool = IDEA_POOL.filter((i) => !except.includes(i));
  const out: string[] = [];
  while (out.length < 3 && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

// Web Speech API (Chrome/Edge). Typed loosely - not in standard lib.
type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
};

function getSpeechRecognition(): (new () => SpeechRec) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRec) | null;
}

const TYPE_IDEAS = [
  "keeps track of my gym streaks",
  "plans dinners for my picky kids",
  "manages bookings for my nail clients",
  "reminds me to water my plants",
  "splits bills with my roommates",
];

export function Home({ go }: { go: (r: Route) => void }) {
  const [idea, setIdea] = useState("");
  const [chips, setChips] = useState(() => pickThree());
  const [starting, setStarting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ghost, setGhost] = useState("");
  const recRef = useRef<SpeechRec | null>(null);

  const micSupported = useMemo(() => getSpeechRecognition() !== null, []);
  const hasAccount = !isGuest() && Boolean(getUserEmail());

  // The input types example ideas to itself until the user starts writing.
  useEffect(() => {
    let phraseIdx = 0;
    let charIdx = 0;
    let deleting = false;
    const timer = setInterval(() => {
      const phrase = TYPE_IDEAS[phraseIdx];
      if (!deleting) {
        charIdx++;
        if (charIdx >= phrase.length + 16) deleting = true;
      } else {
        charIdx = Math.min(charIdx, phrase.length) - 1;
        if (charIdx <= 0) {
          deleting = false;
          phraseIdx = (phraseIdx + 1) % TYPE_IDEAS.length;
        }
      }
      setGhost(phrase.slice(0, Math.min(Math.max(charIdx, 0), phrase.length)));
    }, 65);
    return () => clearInterval(timer);
  }, []);

  function toggleMic() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    const Rec = getSpeechRecognition();
    if (!Rec) return;
    const rec = new Rec();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setIdea((prev) => (prev ? `${prev.trim()} ${text}` : text));
    };
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    recRef.current = rec;
    setRecording(true);
    rec.start();
  }

  async function start() {
    const text = idea.trim();
    if (!text || starting) return;
    setStarting(true);
    setError(null);
    try {
      await ensureSession();
      const project = await api<{ id: string }>("/projects", {
        method: "POST",
        body: { name: "New app" },
      });
      go({ name: "interview", projectId: project.id, idea: text });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong - try again");
      setStarting(false);
    }
  }

  return (
    <div className="home">
      <nav className="topnav">
        <span className="logo">
          <span className="logo-dot" /> Appable
        </span>
        {hasAccount && (
          <button className="btn btn-ghost" onClick={() => go({ name: "apps" })}>
            My apps
          </button>
        )}
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <h1 className="rise">
            Make the app you've
            <br />
            always wanted. <em>No code.</em>
          </h1>
          <p className="sub rise d1">
            Say your idea in plain words. Watch it become a real app on your phone — usually in
            about ten minutes.
          </p>

          <div className="idea-card rise d2">
            <textarea
              placeholder={`I want an app that ${ghost}`}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void start();
                }
              }}
            />
            <div className="idea-actions">
              <div className="idea-left-actions">
                {micSupported && (
                  <button
                    className={recording ? "icon-btn recording" : "icon-btn"}
                    onClick={toggleMic}
                    title={recording ? "Stop recording" : "Speak your idea"}
                  >
                    {recording ? <StopIcon /> : <MicIcon />}
                  </button>
                )}
              </div>
              <button
                className="btn btn-primary"
                onClick={start}
                disabled={!idea.trim() || starting}
              >
                {starting ? "One moment" : "Let's build it"}
              </button>
            </div>
          </div>
          {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}

          <div className="chips rise d3">
            <button className="chip chip-shuffle" onClick={() => setChips(pickThree(chips))}>
              Need an idea?
            </button>
            {chips.map((c) => (
              <button key={c} className="chip" onClick={() => setIdea(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="demo-wrap rise d3" aria-hidden>
          <div className="demo-phone">
            <div className="demo-screen">
              <span className="demo-el demo-app-title">PawWalk</span>
              <span className="demo-el demo-sub">Tuesday — 2 walks booked</span>
              <div className="demo-el demo-btn">Book a walk</div>
              <div className="demo-el demo-card">
                <b>Buddy</b>
                <span>3:00 pm with Sarah</span>
              </div>
              <div className="demo-el demo-card">
                <b>Luna</b>
                <span>5:30 pm with Mike</span>
              </div>
              <div className="demo-el demo-card">
                <b>Biscuit</b>
                <span>Tomorrow, 9:00 am</span>
              </div>
            </div>
          </div>
          <span className="demo-caption">an app being born, on repeat</span>
        </div>
      </section>

      <div className="steps-strip">
        <div className="step-card rise d2">
          <span className="step-num">01</span>
          <b>Say what you want</b>
          <span>Type it or speak it. Plain words are enough.</span>
        </div>
        <div className="step-card rise d3">
          <span className="step-num">02</span>
          <b>Answer a few questions</b>
          <span>A short, friendly chat. No tech talk, promise.</span>
        </div>
        <div className="step-card rise d4">
          <span className="step-num">03</span>
          <b>Watch it come alive</b>
          <span>Your app builds itself in front of you. It's a moment.</span>
        </div>
        <div className="step-card rise d5">
          <span className="step-num">04</span>
          <b>Hold it in your hand</b>
          <span>Scan one code and it's on your real phone.</span>
        </div>
      </div>

      <footer className="home-footer">Appable — for people who've never written a line of code.</footer>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

import { useEffect, useState } from "react";
import type { Route } from "../App.js";
import { api, ensureSession, getUserEmail, isGuest } from "../api.js";
import { MicButton } from "../components/MicButton.js";
import { HoverTip } from "../components/HoverTip.js";
import {
  fetchInitialSuggestions,
  IdeaSuggestionsPanel,
  type SuggestionSet,
} from "../components/IdeaSuggestions.js";

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

/** Interleaved: half “I want an app that…”, half short suggest nudges. */
const GHOST_PHRASES: { kind: "build" | "suggest"; text: string }[] = [
  { kind: "build", text: "keeps track of my gym streaks" },
  { kind: "suggest", text: "Just say gym — we'll find the best idea" },
  { kind: "build", text: "plans dinners for my picky kids" },
  { kind: "suggest", text: "Meal prep on your mind? Hit Suggest ideas" },
  { kind: "build", text: "manages bookings for my nail clients" },
  { kind: "suggest", text: "Dog walking — one word, three apps" },
  { kind: "build", text: "reminds me to water my plants" },
  { kind: "suggest", text: "Type plants… we'll sketch something you'll love" },
  { kind: "build", text: "splits bills with my roommates" },
  { kind: "suggest", text: "Side hustle? We'll find the angle" },
  { kind: "build", text: "helps me stick to a reading habit" },
  { kind: "suggest", text: "Habit tracking — leave the box empty, we'll surprise you" },
];

export function Home({ go }: { go: (r: Route) => void }) {
  const [idea, setIdea] = useState("");
  const [chips, setChips] = useState(() => pickThree());
  const [chipsVisible, setChipsVisible] = useState(true);
  const [starting, setStarting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ghost, setGhost] = useState("");
  const [ghostKind, setGhostKind] = useState<"build" | "suggest">("build");
  const [suggestStack, setSuggestStack] = useState<SuggestionSet[]>([]);
  const [suggestIndex, setSuggestIndex] = useState(0);

  const hasAccount = !isGuest() && Boolean(getUserEmail());
  const showSuggestions = suggestStack.length > 0;
  const placeholder =
    ghostKind === "build" ? `I want an app that ${ghost}` : ghost;
  const suggestSeed = idea.trim() || "Fresh app inspiration";

  useEffect(() => {
    let phraseIdx = 0;
    let charIdx = 0;
    let deleting = false;

    const timer = setInterval(() => {
      const { kind, text } = GHOST_PHRASES[phraseIdx % GHOST_PHRASES.length];
      setGhostKind(kind);

      if (!deleting) {
        charIdx++;
        if (charIdx >= text.length + 14) deleting = true;
      } else {
        charIdx = Math.min(charIdx, text.length) - 1;
        if (charIdx <= 0) {
          deleting = false;
          phraseIdx++;
        }
      }

      setGhost(text.slice(0, Math.min(Math.max(charIdx, 0), text.length)));
    }, 50);

    return () => clearInterval(timer);
  }, []);

  // Cycle example ideas with a soft fade.
  useEffect(() => {
    let swapTimer: ReturnType<typeof setTimeout> | undefined;
    const interval = setInterval(() => {
      setChipsVisible(false);
      swapTimer = setTimeout(() => {
        setChips((prev) => pickThree(prev));
        setChipsVisible(true);
      }, 720);
    }, 5200);
    return () => {
      clearInterval(interval);
      if (swapTimer) clearTimeout(swapTimer);
    };
  }, []);

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

  async function suggestIdeas() {
    if (suggesting) return;
    setSuggesting(true);
    setError(null);
    try {
      const set = await fetchInitialSuggestions(idea);
      setSuggestStack([set]);
      setSuggestIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not suggest ideas — try again");
    } finally {
      setSuggesting(false);
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
              placeholder={placeholder}
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
                <MicButton
                  tip="Speak your idea — we'll handle the rest."
                  onTranscript={(chunk) =>
                    setIdea((prev) => (prev ? `${prev.trim()} ${chunk}` : chunk))
                  }
                />
              </div>
              <div className="idea-actions-right">
                <HoverTip
                  text="Three app ideas worth building — type a topic, or we'll surprise you."
                  delayMs={1000}
                  wide
                >
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void suggestIdeas()}
                    disabled={suggesting}
                  >
                    {suggesting ? "Thinking…" : "Suggest ideas"}
                  </button>
                </HoverTip>
                <button
                  className="btn btn-primary"
                  onClick={() => void start()}
                  disabled={!idea.trim() || starting}
                >
                  {starting ? "One moment" : "Let's build it"}
                </button>
              </div>
            </div>
          </div>

          {showSuggestions && (
            <IdeaSuggestionsPanel
              seed={suggestSeed}
              stack={suggestStack}
              stackIndex={suggestIndex}
              onStackChange={setSuggestStack}
              onStackIndexChange={setSuggestIndex}
              onUseIdea={(text) => {
                setIdea(text);
                setSuggestStack([]);
              }}
            />
          )}

          {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}

          <div className={chipsVisible ? "chips rise d3" : "chips rise d3 chips-fading"}>
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

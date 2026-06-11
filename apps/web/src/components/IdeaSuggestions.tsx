import { useState } from "react";
import { api, ensureSession } from "../api.js";
import { HoverTip } from "./HoverTip.js";

export interface IdeaCard {
  title: string;
  pitch: string;
}

export interface IdeaCardView extends IdeaCard {
  id: string;
  tier: "gold" | "silver";
}

export interface SuggestionSet {
  gold: IdeaCardView;
  silver: [IdeaCardView, IdeaCardView];
}

interface ApiSet {
  gold: IdeaCard;
  silver: [IdeaCard, IdeaCard];
}

function toViewSet(raw: ApiSet): SuggestionSet {
  return {
    gold: { ...raw.gold, id: crypto.randomUUID(), tier: "gold" },
    silver: [
      { ...raw.silver[0], id: crypto.randomUUID(), tier: "silver" },
      { ...raw.silver[1], id: crypto.randomUUID(), tier: "silver" },
    ],
  };
}

function patchSet(set: SuggestionSet, id: string, patch: Partial<IdeaCard>): SuggestionSet {
  const patchOne = (item: IdeaCardView): IdeaCardView =>
    item.id === id ? { ...item, ...patch } : item;
  return {
    gold: patchOne(set.gold),
    silver: [patchOne(set.silver[0]), patchOne(set.silver[1])],
  };
}

export function IdeaSuggestionsPanel({
  seed,
  stack,
  stackIndex,
  onStackChange,
  onStackIndexChange,
  onUseIdea,
}: {
  seed: string;
  stack: SuggestionSet[];
  stackIndex: number;
  onStackChange: (stack: SuggestionSet[]) => void;
  onStackIndexChange: (index: number) => void;
  onUseIdea: (text: string) => void;
}) {
  const current = stack[stackIndex];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [explained, setExplained] = useState<Record<string, string>>({});
  const [explainOpen, setExplainOpen] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (!current) return null;

  function updateCurrent(next: SuggestionSet) {
    onStackChange(stack.map((s, i) => (i === stackIndex ? next : s)));
  }

  async function fetchSimilar(item: IdeaCardView) {
    setBusyId(item.id);
    try {
      await ensureSession();
      const raw = await api<ApiSet>("/ideas/suggest", {
        method: "POST",
        body: { seed, mode: "similar", basedOn: { title: item.title, pitch: item.pitch } },
      });
      const next = toViewSet(raw);
      const truncated = stack.slice(0, stackIndex + 1);
      onStackChange([...truncated, next]);
      onStackIndexChange(stackIndex + 1);
      setExplainOpen(null);
      setEditingId(null);
    } finally {
      setBusyId(null);
    }
  }

  async function fetchExplain(item: IdeaCardView) {
    if (explained[item.id]) {
      setExplainOpen(explainOpen === item.id ? null : item.id);
      return;
    }
    setBusyId(item.id);
    try {
      await ensureSession();
      const res = await api<{ explanation: string }>("/ideas/explain", {
        method: "POST",
        body: { seed, title: item.title, pitch: item.pitch },
      });
      setExplained((prev) => ({ ...prev, [item.id]: res.explanation }));
      setExplainOpen(item.id);
    } finally {
      setBusyId(null);
    }
  }

  function useItem(item: IdeaCardView) {
    onUseIdea(`${item.title}: ${item.pitch}`);
  }

  return (
    <div className="idea-suggestions rise">
      <div className="idea-suggestions-head">
        {stackIndex > 0 ? (
          <button
            type="button"
            className="btn btn-ghost idea-suggestions-back"
            onClick={() => {
              onStackIndexChange(stackIndex - 1);
              setExplainOpen(null);
              setEditingId(null);
            }}
          >
            <BackIcon />
            Back
          </button>
        ) : (
          <span className="idea-suggestions-label">Pick one to start with</span>
        )}
      </div>

      <div className="idea-picks">
        <IdeaPickCard
          item={current.gold}
          busy={busyId === current.gold.id}
          explainOpen={explainOpen === current.gold.id}
          explanation={explained[current.gold.id]}
          editing={editingId === current.gold.id}
          onEdit={() => setEditingId(current.gold.id)}
          onEditDone={() => setEditingId(null)}
          onChange={(patch) => updateCurrent(patchSet(current, current.gold.id, patch))}
          onExplain={() => void fetchExplain(current.gold)}
          onSimilar={() => void fetchSimilar(current.gold)}
          onUse={() => useItem(current.gold)}
        />
        <div className="idea-picks-silver">
          {current.silver.map((item) => (
            <IdeaPickCard
              key={item.id}
              item={item}
              busy={busyId === item.id}
              explainOpen={explainOpen === item.id}
              explanation={explained[item.id]}
              editing={editingId === item.id}
              onEdit={() => setEditingId(item.id)}
              onEditDone={() => setEditingId(null)}
              onChange={(patch) => updateCurrent(patchSet(current, item.id, patch))}
              onExplain={() => void fetchExplain(item)}
              onSimilar={() => void fetchSimilar(item)}
              onUse={() => useItem(item)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export async function fetchInitialSuggestions(seed?: string): Promise<SuggestionSet> {
  await ensureSession();
  const trimmed = seed?.trim() ?? "";
  const raw = await api<ApiSet>("/ideas/suggest", {
    method: "POST",
    body: trimmed ? { seed: trimmed, mode: "initial" as const } : { mode: "random" as const },
  });
  return toViewSet(raw);
}

function IdeaPickCard({
  item,
  busy,
  explainOpen,
  explanation,
  editing,
  onEdit,
  onEditDone,
  onChange,
  onExplain,
  onSimilar,
  onUse,
}: {
  item: IdeaCardView;
  busy: boolean;
  explainOpen: boolean;
  explanation?: string;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  onChange: (patch: Partial<IdeaCard>) => void;
  onExplain: () => void;
  onSimilar: () => void;
  onUse: () => void;
}) {
  return (
    <article className={`idea-pick idea-pick-${item.tier}`}>
      <div className="idea-pick-top">
        <span className={`idea-pick-badge idea-pick-badge-${item.tier}`}>
          {item.tier === "gold" ? "Top pick" : "Also worth a look"}
        </span>
        <div className="idea-pick-title-row">
          {editing ? (
            <input
              className="idea-pick-edit-title"
              value={item.title}
              autoFocus
              onChange={(e) => onChange({ title: e.target.value })}
              onBlur={onEditDone}
              onKeyDown={(e) => e.key === "Enter" && onEditDone()}
            />
          ) : (
            <>
              <h3>{item.title}</h3>
              <HoverTip text="Edit this idea — make it yours" delayMs={900}>
                <button type="button" className="idea-pick-pencil" onClick={onEdit} aria-label="Edit">
                  <PencilIcon />
                </button>
              </HoverTip>
            </>
          )}
        </div>
        {editing ? (
          <textarea
            className="idea-pick-edit-pitch"
            value={item.pitch}
            rows={2}
            onChange={(e) => onChange({ pitch: e.target.value })}
            onBlur={onEditDone}
          />
        ) : (
          <p>{item.pitch}</p>
        )}
      </div>

      {explainOpen && explanation && (
        <div className="idea-pick-explainer">{explanation}</div>
      )}

      <div className="idea-pick-actions">
        <button type="button" className="btn btn-ghost idea-pick-btn" onClick={onExplain} disabled={busy}>
          {busy && !explanation ? "…" : explainOpen ? "Hide" : "Explain"}
        </button>
        <HoverTip text="Three fresh ideas in a similar direction" delayMs={900}>
          <button
            type="button"
            className="btn btn-ghost idea-pick-btn"
            onClick={onSimilar}
            disabled={busy}
          >
            {busy ? "…" : "Similar ideas"}
          </button>
        </HoverTip>
        <button type="button" className="btn btn-primary idea-pick-btn" onClick={onUse} disabled={busy}>
          Use this
        </button>
      </div>
    </article>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

import type { FastifyInstance } from "fastify";
import { completeChat, messageContent, pickSuggestionModel, NO_THINKING_BODY } from "./models.js";
import { requireAuth } from "./auth.js";

export interface IdeaCard {
  title: string;
  pitch: string;
}

export interface IdeaSuggestionResponse {
  gold: IdeaCard;
  silver: [IdeaCard, IdeaCard];
}

export async function ideaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post<{
    Body: {
      seed?: string;
      mode?: "initial" | "similar" | "random";
      basedOn?: IdeaCard;
    };
  }>("/ideas/suggest", async (req, reply) => {
    const seed = req.body?.seed?.trim() ?? "";
    const mode = req.body?.mode ?? (seed ? "initial" : "random");
    const basedOn = req.body?.basedOn;

    if (mode === "similar" && (!basedOn?.title?.trim() || !basedOn?.pitch?.trim())) {
      return reply.code(400).send({ error: "Missing idea to riff on" });
    }

    if (mode === "initial" && !seed) {
      return reply.code(400).send({ error: "Tell us a topic or rough idea first" });
    }

    const system = `You help non-technical people discover mobile app ideas.
Output ONLY valid JSON. No markdown fences, no commentary.
Each pitch is one warm, jargon-free sentence (12–24 words). Titles are short app names (1–3 words).`;

    const user =
      mode === "similar"
        ? `/no_think
The user is exploring apps around: "${seed || "app ideas"}"

They want fresh ideas similar in spirit to:
"${basedOn!.title}" — ${basedOn!.pitch}

Return 3 NEW related but distinct app concepts. Pick the strongest as gold.
JSON shape:
{
  "gold": { "title": string, "pitch": string },
  "silver": [{ "title": string, "pitch": string }, { "title": string, "pitch": string }]
}`
        : mode === "random"
          ? `/no_think
The user hasn't typed anything yet. Surprise them with 3 delightful, distinct mobile app ideas a regular person might actually want to build.
Make them varied (different everyday problems). Pick the most exciting as gold.
JSON shape:
{
  "gold": { "title": string, "pitch": string },
  "silver": [{ "title": string, "pitch": string }, { "title": string, "pitch": string }]
}`
          : `/no_think
The user typed: "${seed}"

Suggest 3 distinct mobile app ideas inspired by that (even if they only wrote one word).
Pick the best fit as gold, two solid alternatives as silver.
JSON shape:
{
  "gold": { "title": string, "pitch": string },
  "silver": [{ "title": string, "pitch": string }, { "title": string, "pitch": string }]
}`;

    try {
      const msg = await completeChat({
        choice: pickSuggestionModel(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        maxTokens: 600,
        extraBody: NO_THINKING_BODY,
      });

      const parsed = parseSuggestionJson(messageContent(msg));
      if (!parsed) {
        return reply.code(502).send({ error: "Could not generate ideas — try again" });
      }
      return parsed;
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Could not generate ideas — try again" });
    }
  });

  app.post<{
    Body: { seed?: string; title?: string; pitch?: string };
  }>("/ideas/explain", async (req, reply) => {
    const seed = req.body?.seed?.trim() ?? "";
    const title = req.body?.title?.trim();
    const pitch = req.body?.pitch?.trim();
    if (!title || !pitch) {
      return reply.code(400).send({ error: "Missing idea to explain" });
    }

    try {
      const msg = await completeChat({
        choice: pickSuggestionModel(),
        messages: [
          {
            role: "system",
            content: `Explain app ideas for non-technical people. Warm, concrete, no jargon.
Output ONLY JSON: { "explanation": string }
The explanation is 2–3 short paragraphs covering who it's for, what they'd do in the app, and what makes it special.`,
          },
          {
            role: "user",
            content: `/no_think
Context from the user: "${seed || "general app idea"}"
App idea: "${title}" — ${pitch}

JSON:`,
          },
        ],
        maxTokens: 500,
        extraBody: NO_THINKING_BODY,
      });

      const raw = messageContent(msg);
      const explanation = parseExplanation(raw);
      if (!explanation) {
        return reply.code(502).send({ error: "Could not explain that idea — try again" });
      }
      return { explanation };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Could not explain that idea — try again" });
    }
  });
}

function parseSuggestionJson(raw: string): IdeaSuggestionResponse | null {
  const found = extractJsonObject(raw);
  if (!found) return null;

  const gold = normalizeCard(found.gold);
  const silverRaw = found.silver;
  if (!gold || !Array.isArray(silverRaw) || silverRaw.length < 2) return null;

  const silver0 = normalizeCard(silverRaw[0]);
  const silver1 = normalizeCard(silverRaw[1]);
  if (!silver0 || !silver1) return null;

  return { gold, silver: [silver0, silver1] };
}

function normalizeCard(v: unknown): IdeaCard | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const pitch = typeof o.pitch === "string" ? o.pitch.trim() : "";
  if (!title || !pitch) return null;
  return { title, pitch };
}

function parseExplanation(raw: string): string | null {
  const found = extractJsonObject(raw);
  if (found && typeof found.explanation === "string" && found.explanation.trim()) {
    return found.explanation.trim();
  }
  const trimmed = raw.trim();
  return trimmed.length > 40 ? trimmed : null;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

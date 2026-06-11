import OpenAI from "openai";
import { env } from "./env.js";

/**
 * Model router. Both providers are OpenAI-compatible; routing is per-task
 * and explicit on purpose:
 *
 *   - interview / brainstorm  -> DeepInfra, cheap chat model (Qwen)
 *   - build (initial app)     -> Fireworks, MiniMax M2.7 (Kimi escalate / DeepInfra fallback)
 *   - edit (follow-up changes)-> Fireworks, MiniMax M2.7 (Kimi escalate / DeepInfra fallback)
 *   - brainstorm escalation   -> build model when the conversation gets heavy
 */

const deepinfra = new OpenAI({
  apiKey: env.deepinfraApiKey,
  baseURL: env.deepinfraBaseUrl,
});

const fireworks = env.fireworksApiKey
  ? new OpenAI({ apiKey: env.fireworksApiKey, baseURL: env.fireworksBaseUrl })
  : null;

const openrouter = env.openrouterApiKey
  ? new OpenAI({
      apiKey: env.openrouterApiKey,
      baseURL: env.openrouterBaseUrl,
      defaultHeaders: { "HTTP-Referer": "https://appable.dev", "X-Title": "Appable" },
    })
  : null;

function isOpenRouterModel(model: string): boolean {
  return model.includes("/") && !model.startsWith("accounts/");
}

function pickBuildEditModel(task: "build" | "edit"): ModelChoice {
  const model = task === "edit" ? env.modelEdit : env.modelBuild;
  if (isOpenRouterModel(model)) {
    if (!openrouter) throw new Error("OpenRouter model configured but OPENROUTER_API_KEY is missing");
    return { client: openrouter, model };
  }
  if (fireworks) return { client: fireworks, model };
  return pickBuildFallback();
}

/** OpenRouter reasoning models: keep customer-facing build logs clean. */
export function providerExtraBody(choice: ModelChoice): Record<string, unknown> | undefined {
  if (isOpenRouterModel(choice.model)) {
    return { reasoning: { enabled: false } };
  }
  return undefined;
}

export type TaskKind = "interview" | "brainstorm" | "build" | "edit";

export interface ModelChoice {
  client: OpenAI;
  model: string;
}

export interface RouteContext {
  /** Number of messages already in the conversation. */
  turnCount?: number;
  /** Latest user message, used for explicit escalation triggers. */
  userText?: string;
}

const ESCALATION_TURNS = 12;
const ESCALATION_CHARS = 600;

export function pickModel(task: TaskKind, ctx: RouteContext = {}): ModelChoice {
  if (task === "build" || task === "edit") return pickBuildEditModel(task);

  // Brainstorm escalates to the build model when the conversation gets
  // long or the user writes something heavy/complex.
  if (task === "brainstorm") {
    if ((ctx.turnCount ?? 0) >= ESCALATION_TURNS) return pickModel("build");
    if ((ctx.userText?.length ?? 0) >= ESCALATION_CHARS) return pickModel("build");
  }
  return { client: deepinfra, model: env.modelChat };
}

/** DeepInfra-hosted Kimi: used when Fireworks is down or misconfigured. */
export function pickBuildFallback(): ModelChoice {
  return { client: deepinfra, model: env.modelBuildFallback };
}

/**
 * Pick model for build/edit/heal. When BUILD_ROUTING=mixed, heal round 1
 * uses the primary (MiniMax); round 2+ switches to MODEL_BUILD_ESCALATE (Kimi).
 */
export function pickAgentModel(task: "build" | "edit", healRound = 0): ModelChoice {
  if (env.buildRouting !== "mixed" || healRound < 2) return pickModel(task);
  if (!fireworks) return pickBuildFallback();
  return { client: fireworks, model: env.modelBuildEscalate };
}

/** Non-reasoning model for interview chat — no thinking text in customer UI. */
export function pickInterviewModel(): ModelChoice {
  return { client: deepinfra, model: env.modelInterview };
}

/** Non-reasoning model for structured tap-suggestion chips (interview only). */
export function pickSuggestionModel(): ModelChoice {
  return { client: deepinfra, model: env.modelSuggestions };
}

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.ChatCompletionTool;

type ExtendedMessage = OpenAI.Chat.ChatCompletionMessage & {
  reasoning_content?: string | null;
};

/** Prefer `content`; strip Qwen thinking dumps if they leak through. */
export function messageContent(msg: ExtendedMessage): string {
  const content = (msg.content ?? "").trim();
  if (content && !looksLikeReasoningDump(content)) return content;

  const fromReasoning = extractCustomerReply(msg.reasoning_content ?? "");
  if (fromReasoning) return fromReasoning;

  return content && !looksLikeReasoningDump(content) ? content : "";
}

const REASONING_MARKERS =
  /\[Output|Proceeds\.|✅|double check|Exact wording|I'll output|Analyze User|thinking process|Wait, let's|Let's stick|Self-Correction|Final Check|\[Final Output\]/i;

function looksLikeReasoningDump(text: string): boolean {
  if (text.length > 900 && REASONING_MARKERS.test(text)) return true;
  if ((text.match(/->/g) ?? []).length >= 2 && REASONING_MARKERS.test(text)) return true;
  return REASONING_MARKERS.test(text) && text.length > 180;
}

/** Pull the customer-facing sentence out of Qwen chain-of-thought. */
function extractCustomerReply(reasoning: string): string {
  const text = reasoning.trim();
  if (!text) return "";
  if (!looksLikeReasoningDump(text)) return text;

  const outputPatterns = [
    /\[Output Generation\]\s*->\s*["']([\s\S]*?)["']\s*$/i,
    /\[Final Output\]\s*->\s*["']([\s\S]*?)["']/i,
    /\[Output\]\s*->\s*["']([\s\S]*?)["']/gi,
  ];
  for (const pattern of outputPatterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      const candidate = matches[matches.length - 1][1].trim();
      if (isLikelyCustomerMessage(candidate)) return candidate;
    }
  }

  const arrows = [...text.matchAll(/->\s*["']([^"'\n]{12,}?)["']/g)];
  for (let i = arrows.length - 1; i >= 0; i--) {
    const candidate = arrows[i][1].trim();
    if (isLikelyCustomerMessage(candidate)) return candidate;
  }

  const quotes = [...text.matchAll(/["“]([^"”\n]{12,}?)["”]/g)];
  for (let i = quotes.length - 1; i >= 0; i--) {
    const candidate = quotes[i][1].trim();
    if (isLikelyCustomerMessage(candidate)) return candidate;
  }

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isLikelyCustomerMessage(lines[i])) return lines[i];
  }

  return "";
}

function isLikelyCustomerMessage(text: string): boolean {
  if (text.length < 12 || text.length > 700) return false;
  if (REASONING_MARKERS.test(text)) return false;
  if (/^\d+\.\s+\*\*/.test(text)) return false;
  if (/^-\s+(Write|Output|Ask|Wait|Let's|I'll|Note:)/i.test(text)) return false;
  return /[?.!]/.test(text) || /\b(you|your|who|what|how|would|want|app)\b/i.test(text);
}

/** DeepInfra / Qwen: skip chain-of-thought for tiny structured outputs. */
export const NO_THINKING_BODY = {
  enable_thinking: false,
  chat_template_kwargs: { enable_thinking: false },
} as const;

/** Streaming chat completion; invokes onDelta per token chunk. */
export async function streamChat(opts: {
  choice: ModelChoice;
  messages: ChatMessage[];
  onDelta: (delta: string) => void;
  maxTokens?: number;
}): Promise<string> {
  const stream = await opts.choice.client.chat.completions.create({
    model: opts.choice.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 2048,
    stream: true,
  });
  let full = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      full += delta;
      opts.onDelta(delta);
    }
  }
  return full;
}

/**
 * Every model call gets a hard deadline so a hung provider can never
 * freeze a build/interview silently. Build calls stream large tool
 * payloads, so they get a longer budget than chat.
 */
const DEFAULT_CALL_TIMEOUT_MS = 90_000;
export const BUILD_CALL_TIMEOUT_MS = 240_000;

export interface CompleteChatOpts {
  choice: ModelChoice;
  messages: ChatMessage[];
  tools?: ChatTool[];
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  /** Hard per-attempt deadline. Defaults to 90s. */
  timeoutMs?: number;
}

/** Non-streaming completion with optional tool calling. Times out instead of hanging. */
export async function completeChat(opts: CompleteChatOpts): Promise<OpenAI.Chat.ChatCompletionMessage> {
  const extraBody = { ...providerExtraBody(opts.choice), ...opts.extraBody };
  const res = await opts.choice.client.chat.completions.create(
    {
      model: opts.choice.model,
      messages: opts.messages,
      tools: opts.tools,
      max_tokens: opts.maxTokens ?? 8192,
      ...(Object.keys(extraBody).length ? { extra_body: extraBody } : {}),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    { timeout: opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, maxRetries: 1 },
  );
  const msg = res.choices[0]?.message;
  if (!msg) throw new Error("Model returned no choices");
  return msg;
}

/**
 * Self-healing completion for the build/edit agent:
 *   attempt 1-2 -> primary provider (timeout + retry)
 *   attempt 3   -> fallback provider (DeepInfra-hosted Kimi)
 * Throws only when every provider failed, so callers surface a real
 * error instead of a silent hang.
 */
export async function completeChatResilient(
  opts: CompleteChatOpts & { onRetry?: (attempt: number, error: string) => void },
): Promise<{ msg: OpenAI.Chat.ChatCompletionMessage; usedFallback: boolean }> {
  const attempts: { choice: ModelChoice; usedFallback: boolean }[] = [
    { choice: opts.choice, usedFallback: false },
    { choice: opts.choice, usedFallback: false },
  ];
  const fallback = pickBuildFallback();
  if (fallback.model !== opts.choice.model || fallback.client !== opts.choice.client) {
    attempts.push({ choice: fallback, usedFallback: true });
  }

  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const { choice, usedFallback } = attempts[i]!;
    try {
      const msg = await completeChat({ ...opts, choice });
      return { msg, usedFallback };
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      opts.onRetry?.(i + 1, message);
      if (i < attempts.length - 1) {
        await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

import OpenAI from "openai";
import { env } from "./env.js";

/**
 * Model router. Both providers are OpenAI-compatible; routing is per-task
 * and explicit on purpose:
 *
 *   - interview / brainstorm  -> DeepInfra, cheap chat model (Qwen)
 *   - build (initial app)     -> DeepInfra, build model (Kimi K2.6)
 *   - edit (follow-up changes)-> Fireworks, Kimi K2.6 (faster tokens = snappy edits)
 *   - brainstorm escalation   -> build model when the conversation gets heavy
 */

const deepinfra = new OpenAI({
  apiKey: env.deepinfraApiKey,
  baseURL: env.deepinfraBaseUrl,
});

const fireworks = env.fireworksApiKey
  ? new OpenAI({ apiKey: env.fireworksApiKey, baseURL: env.fireworksBaseUrl })
  : null;

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
  if (task === "build") return { client: deepinfra, model: env.modelBuild };

  // Edits run on Fireworks when configured (faster), otherwise fall back
  // to the DeepInfra build model.
  if (task === "edit") {
    return fireworks
      ? { client: fireworks, model: env.modelEdit }
      : { client: deepinfra, model: env.modelBuild };
  }

  // Brainstorm escalates to the build model when the conversation gets
  // long or the user writes something heavy/complex.
  if (task === "brainstorm") {
    if ((ctx.turnCount ?? 0) >= ESCALATION_TURNS) return { client: deepinfra, model: env.modelBuild };
    if ((ctx.userText?.length ?? 0) >= ESCALATION_CHARS) return { client: deepinfra, model: env.modelBuild };
  }
  return { client: deepinfra, model: env.modelChat };
}

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.ChatCompletionTool;

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

/** Non-streaming completion with optional tool calling. */
export async function completeChat(opts: {
  choice: ModelChoice;
  messages: ChatMessage[];
  tools?: ChatTool[];
  maxTokens?: number;
}): Promise<OpenAI.Chat.ChatCompletionMessage> {
  const res = await opts.choice.client.chat.completions.create({
    model: opts.choice.model,
    messages: opts.messages,
    tools: opts.tools,
    max_tokens: opts.maxTokens ?? 8192,
  });
  const msg = res.choices[0]?.message;
  if (!msg) throw new Error("Model returned no choices");
  return msg;
}

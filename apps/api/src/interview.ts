import { randomUUID } from "node:crypto";
import { getDb } from "@appable/db";
import type { AppSpec, LegalDocs } from "@appable/shared";
import { emit } from "./events.js";
import { pickInterviewModel, pickModel, pickSuggestionModel, streamChat, completeChat, messageContent, NO_THINKING_BODY, type ChatMessage } from "./models.js";

/**
 * Interview pipeline: a structured intake conversation (cheap model) that
 * ends in a versioned AppSpec, plus a free-form brainstorm mode that
 * escalates to the build model when the conversation gets heavy.
 */

const SPEC_READY_MARKER = "[SPEC_READY]";

const INTERVIEW_SYSTEM = `You are Appable's friendly app interviewer. The user
has an app idea but cannot code. Your job is to understand their idea well
enough to build it.

Rules:
- Ask exactly ONE question per message. Keep it short, warm and jargon-free.
- Ask at most 6 questions total before wrapping up. Cover: who it's for, the
  2-3 core things a user does in the app, what data it shows/saves, look &
  feel (colors/vibe), and anything unique about their idea.
- Your LAST question before the summary MUST ask what they'd like to name
  their app (e.g. "What would you like to call your app?"). Do not summarize
  until they answer the name question (or say "Let Appable pick" for it).
- Never mention code, databases, frameworks or technical terms.
- If the user says "Let Appable pick", choose a sensible answer to your
  previous question for them (for the name question, pick a short catchy name
  that fits their app), say what you picked in one short sentence, then ask
  your next question — or summarize if the name was the last question.
- If the user picks multiple options at once (comma-separated), combine them
  into one friendly answer — they mean all of those apply.
- After the app-name question is answered, send a final message that
  summarizes their app in 3-5 friendly bullet points (include the chosen
  name), then end the message with the exact marker ${SPEC_READY_MARKER} on
  its own line.
- If the user says "Let's go deeper" after the summary, ask what they'd like
  to refine and continue the interview (one question at a time) until they
  are happy, then summarize again with ${SPEC_READY_MARKER}.`;

const BRAINSTORM_SYSTEM = `You are Appable's brainstorm buddy. The user is a
non-technical person exploring an app idea. Help them think it through:
features, audience, naming, what to build first. Be concise, warm, concrete
and jargon-free. Never mention code or technical implementation details.`;

const SPEC_EXTRACTION_PROMPT = `Based on the interview conversation above,
output the app specification as pure JSON (no markdown fences, no prose)
matching exactly this TypeScript shape:

{
  "name": string,              // short app name
  "tagline": string,           // one-line pitch
  "description": string,       // 2-3 sentences
  "category": string,          // e.g. "fitness", "productivity"
  "vibe": { "tone": string, "primaryColor": string, "style": string },
  "screens": [ { "name": string, "purpose": string, "elements": [string] } ],
  "dataModel": [ { "name": string, "fields": [ { "name": string, "type": string } ] } ],
  "features": [string],
  "nonGoals": [string]
}

Design 3-5 screens that make sense for the idea. primaryColor must be a hex
color. Output ONLY the JSON object.`;

type Kind = "interview" | "brainstorm";

export async function handleChat(
  projectId: string,
  kind: Kind,
  userText: string,
): Promise<void> {
  const db = getDb();

  const conversation = await db.conversation.upsert({
    where: { projectId_kind: { projectId, kind } },
    create: { projectId, kind },
    update: {},
  });

  await db.message.create({
    data: { conversationId: conversation.id, role: "user", content: userText },
  });

  const history = await db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
  });

  const system = kind === "interview" ? INTERVIEW_SYSTEM : BRAINSTORM_SYSTEM;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...history.map(
      (m): ChatMessage => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      }),
    ),
  ];

  const choice =
    kind === "interview"
      ? pickInterviewModel()
      : pickModel(kind, { turnCount: history.length, userText });
  const model = choice.model;
  const messageId = randomUUID();

  let full: string;
  if (kind === "interview") {
    const msg = await completeChat({ choice, messages, maxTokens: 1024 });
    full = messageContent(msg);
    const specReady = full.includes(SPEC_READY_MARKER);
    const displayText = full.replace(SPEC_READY_MARKER, "").trim();
    const specTask = specReady
      ? startSpecExtraction(projectId, messages, full)
      : null;
    await deliverInterviewReply(projectId, messageId, displayText, specReady, messages);
    if (specTask) {
      void specTask;
    }
  } else {
    full = await streamChat({
      choice,
      messages,
      onDelta: (delta) =>
        emit(projectId, { type: "chat.delta", conversation: kind, messageId, delta }),
    });
  }

  const specReady = kind === "interview" && full.includes(SPEC_READY_MARKER);
  const displayText = full.replace(SPEC_READY_MARKER, "").trim();

  await db.message.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: displayText,
      model,
    },
  });

  emit(projectId, {
    type: "chat.done",
    conversation: kind,
    messageId,
    text: displayText,
    model,
  });

  if (specReady && kind !== "interview") {
    void startSpecExtraction(projectId, messages, full);
  }
}

const specTasks = new Map<string, Promise<boolean>>();

async function startSpecExtraction(
  projectId: string,
  conversation: ChatMessage[],
  finalSummary: string,
): Promise<boolean> {
  const existing = specTasks.get(projectId);
  if (existing) return existing;

  const task = extractAndSaveSpec(projectId, conversation, finalSummary)
    .then(() => true)
    .catch((err) => {
      console.warn("[interview] spec extraction failed:", err);
      return false;
    })
    .finally(() => {
      specTasks.delete(projectId);
    });

  specTasks.set(projectId, task);
  return task;
}

/** Idempotent: returns true once a spec exists (creates one from interview if needed). */
export async function ensureProjectSpec(projectId: string): Promise<boolean> {
  const db = getDb();
  if (await db.spec.findFirst({ where: { projectId } })) return true;

  const inFlight = specTasks.get(projectId);
  if (inFlight) return inFlight;

  const conv = await db.conversation.findUnique({
    where: { projectId_kind: { projectId, kind: "interview" } },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conv || conv.messages.length < 4) return false;

  const assistants = conv.messages.filter((m) => m.role === "assistant");
  if (assistants.length < 2) return false;

  const lastAssistant = assistants[assistants.length - 1];
  if (!lastAssistant?.content.trim()) return false;

  const messages: ChatMessage[] = [
    { role: "system", content: INTERVIEW_SYSTEM },
    ...conv.messages.map(
      (m): ChatMessage => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      }),
    ),
  ];

  return startSpecExtraction(projectId, messages, lastAssistant.content);
}

async function extractAndSaveSpec(
  projectId: string,
  conversation: ChatMessage[],
  finalSummary: string,
): Promise<void> {
  const db = getDb();
  emit(projectId, {
    type: "agent.status",
    status: "planning",
    message: "Putting your app plan together...",
  });

  const extractionMessages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You turn app interview summaries into structured JSON specs. Output ONLY a valid JSON object, no markdown.",
    },
    {
      role: "user",
      content: `/no_think\nInterview summary:\n${finalSummary.replace(SPEC_READY_MARKER, "").trim()}\n\n${SPEC_EXTRACTION_PROMPT}`,
    },
  ];

  const msg = await completeChat({
    choice: pickInterviewModel(),
    messages: extractionMessages,
    maxTokens: 4096,
    extraBody: NO_THINKING_BODY,
  });

  const spec = parseSpecJson(messageContent(msg as Parameters<typeof messageContent>[0]));
  if (spec) spec.legal = makeLegalDocs(spec.name);
  if (!spec) {
    const raw = messageContent(msg as Parameters<typeof messageContent>[0]);
    console.warn(
      "[interview] spec parse failed for",
      projectId,
      raw.slice(0, 400),
    );
    emit(projectId, {
      type: "error",
      code: "spec_extraction_failed",
      message: "Could not generate the app plan. Try answering one more question.",
    });
    return;
  }

  const latest = await db.spec.findFirst({
    where: { projectId },
    orderBy: { version: "desc" },
  });
  const version = (latest?.version ?? 0) + 1;

  await db.spec.create({
    data: { projectId, version, data: spec as object },
  });
  await db.project.update({
    where: { id: projectId },
    data: { status: "spec_ready", name: spec.name },
  });

  emit(projectId, { type: "spec.updated", version, spec });
  emit(projectId, { type: "project.status", status: "spec_ready" });
  emit(projectId, {
    type: "agent.status",
    status: "idle",
    message: "Your app plan is ready - press Build when you are!",
  });
}

function makeLegalDocs(appName: string): LegalDocs {
  const date = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return {
    privacy: `Privacy Policy for ${appName}
Last updated: ${date}

Your privacy matters. Here's the short version:

1. Your data stays on your device. ${appName} stores the things you add (your entries, settings and preferences) locally on your phone. We don't upload them to a server.

2. No tracking. ${appName} does not collect analytics, show ads, or share anything with third parties.

3. No account needed. You can use ${appName} without creating an account or giving us personal information.

4. Deleting your data. Removing the app removes your data. You can also clear it any time from your phone's settings.

5. Changes. If this policy ever changes, the updated version will be available right here in the app.

Questions? See the Support page.

${appName} is built with Appable.`,
    terms: `Terms of Service for ${appName}
Last updated: ${date}

By using ${appName}, you agree to these simple terms:

1. Personal use. ${appName} is provided for your personal use, as-is. Use it for anything legal and reasonable.

2. Your content is yours. Anything you create or save in ${appName} belongs to you.

3. No guarantees. We work hard to keep ${appName} working well, but it's provided without warranties of any kind. We're not liable for lost data or damages from using the app.

4. Fair use. Don't attempt to abuse, reverse-engineer or disrupt the app or its services.

5. Changes. Features may improve or change over time. If these terms change, the new version will be available here.

${appName} is built with Appable.`,
    support: `Support for ${appName}

Need help? We've got you.

Common fixes:
- App acting strange? Close it fully and reopen it.
- Data not showing? Make sure you're on the latest version.
- Something looks broken? Reinstalling the app is safe - but note it clears locally stored data.

Still stuck?
Reach out through the Appable dashboard where you built this app - the same chat you used to build it can fix bugs and make changes. Just describe the problem.

${appName} is built with Appable.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WRAPUP_SUGGESTIONS = ["Start building", "Let's go deeper"];

/** Type the reply; drop suggestion chips the moment the question bubble starts. */
async function deliverInterviewReply(
  projectId: string,
  messageId: string,
  question: string,
  specReady: boolean,
  messages: ChatMessage[],
): Promise<void> {
  const delayMs = specReady ? 10 : 26;
  const parts = question.match(/\S+\s*/g) ?? (question ? [question] : []);

  const suggestions = specReady
    ? WRAPUP_SUGGESTIONS
    : question
      ? await generateSuggestions(messages, question)
      : null;
  const mode = specReady ? ("wrapup" as const) : ("answer" as const);

  let startIdx = 0;
  if (parts.length > 0 && suggestions) {
    emit(projectId, {
      type: "chat.suggestions",
      conversation: "interview",
      messageId,
      suggestions,
      mode,
    });
    emit(projectId, {
      type: "chat.delta",
      conversation: "interview",
      messageId,
      delta: parts[0]!,
    });
    startIdx = 1;
  } else if (suggestions) {
    emit(projectId, {
      type: "chat.suggestions",
      conversation: "interview",
      messageId,
      suggestions,
      mode,
    });
  }

  for (let i = startIdx; i < parts.length; i++) {
    emit(projectId, {
      type: "chat.delta",
      conversation: "interview",
      messageId,
      delta: parts[i]!,
    });
    if (delayMs > 0) await sleep(delayMs);
  }
}

function interviewContext(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system" || typeof m.content !== "string") continue;
    const label = m.role === "user" ? "User" : "Interviewer";
    lines.push(`${label}: ${m.content.trim()}`);
  }
  return lines.join("\n");
}

function isNamingQuestion(question: string): boolean {
  return /\b(name|call|title)\b.*\b(app|it)\b|\bwhat.*\bcall\b/i.test(question);
}

async function generateSuggestions(
  messages: ChatMessage[],
  question: string,
): Promise<string[]> {
  const context = interviewContext(messages);
  const naming = isNamingQuestion(question);

  try {
    const choice = pickSuggestionModel();
    const msg = await completeChat({
      choice,
      messages: [
        {
          role: "system",
          content: naming
            ? `Write 3 tap-to-answer chips suggesting app names for what the user is building.
Each chip is a short app name (1-3 words) that fits their idea and vibe.
Names must feel specific to THIS app — not generic placeholders.
Output ONLY a JSON array of exactly 3 strings. No markdown, no explanation.`
            : `Write 3 tap-to-answer chips for an app interview question.
Each chip 3-10 words, plain language, directly answers the question.
Chips must fit what the user is actually building — use details from the
conversation, not generic filler.
Output ONLY a JSON array of exactly 3 strings. No markdown, no explanation.`,
        },
        {
          role: "user",
          content: `/no_think\nConversation so far:\n${context}\n\nQuestion:\n${question}\n\nJSON array:`,
        },
      ],
      maxTokens: naming ? 80 : 120,
      extraBody: NO_THINKING_BODY,
    });

    const parsed = parseSuggestionArray(
      messageContent(msg),
      (msg as { reasoning_content?: string }).reasoning_content ?? "",
    );
    if (parsed) return parsed;
  } catch (err) {
    console.warn("[interview] suggestion generation failed:", err);
  }

  let idea = "";
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      idea = m.content;
      break;
    }
  }
  return fallbackSuggestions(question, idea);
}

function parseSuggestionArray(content: string, reasoning: string): string[] | null {
  for (const raw of [content, reasoning, `${content}\n${reasoning}`]) {
    const found = extractJsonStringArray(raw);
    if (found) return found;
  }
  return null;
}

function extractJsonStringArray(text: string): string[] | null {
  const matches = [...text.matchAll(/\[\s*"[\s\S]*?"\s*(?:,\s*"[\s\S]*?"\s*){2,}\]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i][0]) as unknown;
      if (!Array.isArray(parsed) || parsed.length < 3) continue;
      const items = parsed
        .slice(0, 3)
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length === 3 && !items.some((s) => /answer one here|opt1|placeholder/i.test(s))) {
        return items;
      }
    } catch {
      // try earlier match
    }
  }
  return null;
}

function fallbackSuggestions(question: string, idea: string): string[] {
  const q = question.toLowerCase();
  if (isNamingQuestion(question)) {
    return nameFallbacks(idea);
  }
  if (/who|audience|for|users|people|mainly|household/.test(q)) {
    return ["Just me and my household", "Busy parents mainly", "Pretty much anyone"];
  }
  if (/main things|does in|features|do in the app|what.*do|pick|check|track/.test(q)) {
    return featureFallbacks(idea);
  }
  if (/look|feel|color|vibe|design|style|theme/.test(q)) {
    return ["Clean and minimal", "Warm and cozy", "Bold and colorful"];
  }
  if (/data|save|track|show|store|remember/.test(q)) {
    return dataFallbacks(idea);
  }
  return ["Something simple", "I'll explain in my own words", "Keep it flexible"];
}

function nameFallbacks(idea: string): string[] {
  const lower = idea.toLowerCase();
  if (/habit|streak|gym|workout|fitness|exercise/.test(lower)) {
    return ["StreakLift", "GymHabits", "RepCheck"];
  }
  if (/meal|recipe|grocery|food|cook|kitchen/.test(lower)) {
    return ["MealMinder", "PantryPal", "PlatePlan"];
  }
  if (/budget|money|expense|finance|spend/.test(lower)) {
    return ["PennyPath", "SpendSnap", "CashCalm"];
  }
  if (/todo|task|project|productivity|remind/.test(lower)) {
    return ["TaskTide", "DoneDay", "FocusFlow"];
  }
  return ["MyApp", "DayOne", "SimpleStart"];
}

function featureFallbacks(idea: string): string[] {
  const lower = idea.toLowerCase();
  if (/habit|streak|gym|workout|fitness|exercise/.test(lower)) {
    return ["Check off daily workouts", "Track my streaks", "Add and manage habits"];
  }
  if (/meal|recipe|grocery|food|cook/.test(lower)) {
    return ["Plan my weekly meals", "Build my grocery list", "Save favorite recipes"];
  }
  return ["Track what matters most", "See my progress at a glance", "Add and organize items"];
}

function dataFallbacks(idea: string): string[] {
  const lower = idea.toLowerCase();
  if (/habit|streak|gym|workout|fitness|exercise/.test(lower)) {
    return ["Habits and daily check-ins", "Streak counts per habit", "Workout history"];
  }
  if (/meal|recipe|grocery|food|cook/.test(lower)) {
    return ["Saved recipes and favorites", "Weekly meal plans", "Grocery lists"];
  }
  return ["My entries and history", "Lists and favorites", "Simple notes only"];
}

function parseSpecJson(text: string): AppSpec | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (
      typeof parsed.name === "string" &&
      Array.isArray(parsed.screens) &&
      parsed.screens.length > 0
    ) {
      // Fill any missing optional sections so downstream code can rely on shape.
      parsed.tagline ??= "";
      parsed.description ??= "";
      parsed.category ??= "general";
      parsed.vibe ??= { tone: "friendly", primaryColor: "#6C5CE7", style: "clean" };
      parsed.dataModel ??= [];
      parsed.features ??= [];
      parsed.nonGoals ??= [];
      return parsed as AppSpec;
    }
    return null;
  } catch {
    return null;
  }
}

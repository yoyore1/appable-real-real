import { randomUUID } from "node:crypto";
import { getDb } from "@appable/db";
import type { AppSpec, LegalDocs } from "@appable/shared";
import { emit } from "./events.js";
import { pickModel, streamChat, completeChat, type ChatMessage } from "./models.js";

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
- Ask at most 6 questions total. Cover: who it's for, the 2-3 core things a
  user does in the app, what data it shows/saves, look & feel (colors/vibe),
  and anything unique about their idea.
- Never mention code, databases, frameworks or technical terms.
- When you have enough (or after 6 questions), send a final message that
  summarizes their app in 3-5 friendly bullet points, then end the message
  with the exact marker ${SPEC_READY_MARKER} on its own line.`;

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

  const choice = pickModel(kind, { turnCount: history.length, userText });
  const model = choice.model;
  const messageId = randomUUID();

  const full = await streamChat({
    choice,
    messages,
    onDelta: (delta) =>
      emit(projectId, { type: "chat.delta", conversation: kind, messageId, delta }),
  });

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

  if (specReady) {
    await extractAndSaveSpec(projectId, messages, full);
  }
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
    ...conversation,
    { role: "assistant", content: finalSummary },
    { role: "user", content: SPEC_EXTRACTION_PROMPT },
  ];

  const msg = await completeChat({
    choice: pickModel("interview"),
    messages: extractionMessages,
    maxTokens: 4096,
  });

  const spec = parseSpecJson(msg.content ?? "");
  if (spec) spec.legal = makeLegalDocs(spec.name);
  if (!spec) {
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

/** Simple, readable legal/support docs every app gets out of the box. */
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

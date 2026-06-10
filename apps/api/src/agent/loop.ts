import { getDb } from "@appable/db";
import type { AppSpec } from "@appable/shared";
import { emit } from "../events.js";
import { completeChat, pickModel, type ChatMessage, type ModelChoice } from "../models.js";
import { randomUUID } from "node:crypto";
import {
  checkBundle,
  createCheckpoint,
  ensureRunning,
  getHeadRef,
  getProjectLogs,
  listProjectFiles,
  resetToGitRef,
  touch,
} from "../orchestrator.js";
import { buildSystemPrompt, editSystemPrompt, healSystemPrompt } from "./prompts.js";
import { agentTools, executeTool } from "./tools.js";

const MAX_ITERATIONS = 80;
const MAX_HEAL_ROUNDS = 3;
const HEAL_ITERATIONS = 20;

const activeBuilds = new Map<string, { cancelled: boolean }>();

export function cancelBuild(projectId: string): void {
  const state = activeBuilds.get(projectId);
  if (state) state.cancelled = true;
}

export function isBuilding(projectId: string): boolean {
  return activeBuilds.has(projectId);
}

async function logBuild(
  projectId: string,
  level: "info" | "warn" | "error",
  source: "agent" | "metro" | "system",
  text: string,
): Promise<void> {
  emit(projectId, {
    type: "build.event",
    level,
    source,
    text,
    timestamp: new Date().toISOString(),
  });
  const db = getDb();
  await db.buildEvent.create({ data: { projectId, level, source, text } }).catch(() => {});
}

function status(
  projectId: string,
  s: "idle" | "planning" | "writing" | "installing" | "checking" | "fixing" | "done" | "failed",
  message: string,
): void {
  emit(projectId, { type: "agent.status", status: s, message });
}

/**
 * The build agent: plan-then-execute tool loop with Metro error self-healing.
 */
export async function runBuild(projectId: string): Promise<void> {
  if (activeBuilds.has(projectId)) {
    throw new Error("A build is already running for this project");
  }
  const state = { cancelled: false };
  activeBuilds.set(projectId, state);

  const db = getDb();
  try {
    const spec = await loadLatestSpec(projectId);
    if (!spec) {
      throw new Error("No spec yet - finish the interview before building");
    }

    await db.project.update({ where: { id: projectId }, data: { status: "building" } });
    emit(projectId, { type: "project.status", status: "building" });

    status(projectId, "planning", "Getting your workspace ready...");
    await ensureRunning(projectId);
    await touch(projectId);

    const files = await listProjectFiles(projectId);
    const choice = pickModel("build");

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(spec, files) },
      {
        role: "user",
        content:
          "Build the app now. Start with your short plan, then execute it with tools.",
      },
    ];

    status(projectId, "planning", "Planning your app...");
    const finished = await agentLoop(projectId, choice, messages, MAX_ITERATIONS, state, "BUILD COMPLETE");
    if (state.cancelled) {
      await finishCancelled(projectId);
      return;
    }
    if (!finished) {
      await logBuild(projectId, "warn", "system", "Agent hit the iteration limit; proceeding to checks.");
    }

    // Self-heal loop: read Metro logs, fix anything red, repeat.
    for (let round = 1; round <= MAX_HEAL_ROUNDS; round++) {
      if (state.cancelled) {
        await finishCancelled(projectId);
        return;
      }
      status(projectId, "checking", "Checking your app for problems...");
      // Force a real bundle compile - this is what actually surfaces errors.
      const bundleError = await checkBundle(projectId);
      const logs = await getProjectLogs(projectId, 150);
      const logErrors = extractErrors(logs);
      const errors = [bundleError, logErrors].filter(Boolean).join("\n---\n") || null;
      if (!errors) break;

      status(projectId, "fixing", "Polishing a few details...");
      await logBuild(projectId, "warn", "metro", `Errors detected (heal round ${round}):\n${errors}`);

      const healMessages: ChatMessage[] = [
        { role: "system", content: healSystemPrompt(spec) },
        {
          role: "user",
          content: `The Expo dev server is reporting errors. Fix them.\n\nRecent logs:\n${errors}`,
        },
      ];
      await agentLoop(projectId, choice, healMessages, HEAL_ITERATIONS, state, "FIX COMPLETE");
    }

    status(projectId, "checking", "Saving your progress...");
    await createCheckpoint(projectId, "build").catch((err) =>
      logBuild(projectId, "warn", "system", `Checkpoint failed: ${err.message}`),
    );

    await db.project.update({ where: { id: projectId }, data: { status: "running" } });
    emit(projectId, { type: "project.status", status: "running" });
    status(projectId, "done", "Your app is ready!");
    await logBuild(projectId, "info", "system", "Build finished.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logBuild(projectId, "error", "system", `Build failed: ${message}`);
    await db.project.update({ where: { id: projectId }, data: { status: "error" } }).catch(() => {});
    emit(projectId, { type: "project.status", status: "error" });
    status(projectId, "failed", "Something went wrong building your app.");
  } finally {
    activeBuilds.delete(projectId);
  }
}

const EDIT_ITERATIONS = 30;

/**
 * Edit mode: the user asked for a change to an already-built app.
 * Pipeline: checkpoint -> surgical agent edit -> bundle verify ->
 * checkpoint on success / hard rollback on failure.
 */
export async function runEdit(projectId: string, request: string): Promise<void> {
  if (activeBuilds.has(projectId)) {
    emit(projectId, {
      type: "error",
      code: "busy",
      message: "I'm still working on the previous change - one moment.",
    });
    return;
  }
  const state = { cancelled: false };
  activeBuilds.set(projectId, state);

  const db = getDb();
  const conversation = await db.conversation.upsert({
    where: { projectId_kind: { projectId, kind: "build" } },
    create: { projectId, kind: "build" },
    update: {},
  });
  await db.message.create({
    data: { conversationId: conversation.id, role: "user", content: request },
  });

  let safeRef: string | null = null;
  try {
    const spec = await loadLatestSpec(projectId);
    if (!spec) throw new Error("No spec - build the app before editing it");

    status(projectId, "planning", "Looking at your app...");
    await ensureRunning(projectId);
    await touch(projectId);

    // Safety net: remember exactly where we started.
    safeRef = await getHeadRef(projectId);

    const files = await listProjectFiles(projectId);
    const choice = pickModel("edit");
    const messages: ChatMessage[] = [
      { role: "system", content: editSystemPrompt(spec, files) },
      { role: "user", content: request },
    ];

    status(projectId, "writing", "Making your change...");
    const finished = await agentLoop(projectId, choice, messages, EDIT_ITERATIONS, state, "EDIT COMPLETE");

    // Verify the bundle still compiles; one heal round if not.
    status(projectId, "checking", "Double-checking everything still works...");
    let bundleError = await checkBundle(projectId);
    if (bundleError) {
      status(projectId, "fixing", "Fixing a small issue...");
      const healMessages: ChatMessage[] = [
        { role: "system", content: healSystemPrompt(spec) },
        { role: "user", content: `Your edit broke the build. Fix it.\n\n${bundleError}` },
      ];
      await agentLoop(projectId, choice, healMessages, HEAL_ITERATIONS, state, "FIX COMPLETE");
      bundleError = await checkBundle(projectId);
    }

    if (bundleError) {
      // Could not make it work - roll back so the user keeps a working app.
      await resetToGitRef(projectId, safeRef);
      await sendEditReply(
        projectId,
        conversation.id,
        "I couldn't make that change without breaking your app, so I left everything as it was. Try describing it a bit differently.",
        choice.model,
      );
      status(projectId, "idle", "Change rolled back - your app is untouched.");
      return;
    }

    await createCheckpoint(projectId, `edit: ${request.slice(0, 60)}`).catch(() => {});

    // Extract the friendly summary from the agent's final message.
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && typeof m.content === "string" && m.content);
    let summary =
      lastAssistant && typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : "";
    const marker = summary.indexOf("EDIT COMPLETE:");
    summary = marker >= 0 ? summary.slice(marker + "EDIT COMPLETE:".length).trim() : "Done!";
    if (!finished && !summary) summary = "Done - your change is in!";

    await sendEditReply(projectId, conversation.id, summary || "Done - your change is in!", choice.model);
    status(projectId, "done", "Change complete!");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logBuild(projectId, "error", "system", `Edit failed: ${message}`);
    if (safeRef) await resetToGitRef(projectId, safeRef).catch(() => {});
    await sendEditReply(
      projectId,
      conversation.id,
      "Something went wrong making that change, so I left your app exactly as it was.",
      pickModel("edit").model,
    );
    status(projectId, "failed", "Couldn't make that change - your app is safe.");
  } finally {
    activeBuilds.delete(projectId);
  }
}

async function sendEditReply(
  projectId: string,
  conversationId: string,
  text: string,
  model: string,
): Promise<void> {
  const db = getDb();
  await db.message.create({
    data: { conversationId, role: "assistant", content: text, model },
  });
  emit(projectId, {
    type: "chat.done",
    conversation: "build",
    messageId: randomUUID(),
    text,
    model,
  });
}

/**
 * Generic agentic tool loop. Returns true when the agent declared completion
 * (its final text contains `doneMarker`).
 */
async function agentLoop(
  projectId: string,
  choice: ModelChoice,
  messages: ChatMessage[],
  maxIterations: number,
  state: { cancelled: boolean },
  doneMarker: string,
): Promise<boolean> {
  for (let i = 0; i < maxIterations; i++) {
    if (state.cancelled) return false;

    const msg = await completeChat({ choice, messages, tools: agentTools });
    messages.push(msg as ChatMessage);

    if (msg.content) {
      await logBuild(projectId, "info", "agent", msg.content);
    }

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return Boolean(msg.content?.includes(doneMarker));
    }

    for (const call of toolCalls) {
      if (state.cancelled) return false;
      if (call.type !== "function") continue;

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // leave args empty; the tool will fail loudly and the model can retry
      }

      reportToolStatus(projectId, call.function.name, args);

      let result: string;
      try {
        result = await executeTool(projectId, call.function.name, args);
      } catch (err) {
        result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        await logBuild(projectId, "warn", "system", `${call.function.name} failed: ${result}`);
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    await touch(projectId);
  }
  return false;
}

function reportToolStatus(
  projectId: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  switch (toolName) {
    case "write_file":
      status(projectId, "writing", `Writing ${String(args.path ?? "a file")}...`);
      break;
    case "run_command":
      status(projectId, "installing", "Running a setup step...");
      break;
    case "read_build_logs":
      status(projectId, "checking", "Checking the build...");
      break;
    default:
      break;
  }
}

function extractErrors(logs: string): string | null {
  const lines = logs.split("\n");
  const errorPatterns =
    /(unable to resolve|module not found|syntaxerror|typeerror:|referenceerror|cannot find|bundling failed|\berror\b[:!])/i;
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (errorPatterns.test(lines[i])) {
      // include a little context around each hit
      hits.push(lines.slice(Math.max(0, i - 1), i + 4).join("\n"));
    }
  }
  if (hits.length === 0) return null;
  return [...new Set(hits)].slice(-5).join("\n---\n");
}

async function finishCancelled(projectId: string): Promise<void> {
  const db = getDb();
  await db.project.update({ where: { id: projectId }, data: { status: "running" } }).catch(() => {});
  status(projectId, "idle", "Build cancelled.");
  await logBuild(projectId, "info", "system", "Build cancelled by user.");
}

async function loadLatestSpec(projectId: string): Promise<AppSpec | null> {
  const db = getDb();
  const spec = await db.spec.findFirst({
    where: { projectId },
    orderBy: { version: "desc" },
  });
  return spec ? (spec.data as unknown as AppSpec) : null;
}

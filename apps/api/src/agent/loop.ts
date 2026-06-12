import { getDb } from "@appable/db";
import type { AppSpec } from "@appable/shared";
import { emit } from "../events.js";
import {
  BUILD_CALL_TIMEOUT_MS,
  completeChatResilient,
  pickAgentModel,
  pickModel,
  type ChatMessage,
  type ModelChoice,
} from "../models.js";
import { env } from "../env.js";
import { randomUUID } from "node:crypto";
import {
  createCheckpoint,
  ensureRunning,
  getHeadRef,
  getProjectLogs,
  invalidateMetroBundle,
  listProjectFiles,
  resetToGitRef,
  touch,
  verifyApp,
  resolveLivePreview,
} from "../orchestrator.js";
import {
  buildSystemPrompt,
  editSystemPrompt,
  healSystemPrompt,
} from "./prompts.js";
import { scheduleBrainstormSnapshotRefresh } from "../brainstormSnapshot.js";
import { runDesignPolishPass } from "./designPolish.js";
import {
  runTapEditHygienePass,
  tapEditAuditBlocked,
  tapEditHygieneFailed,
} from "./tapEditHygiene.js";
import { tryTapEditPatch } from "./tapEdit.js";
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

/** DB stuck on "building" after API restart while the app already runs. */
export async function reconcileStaleBuildingStatus(projectId: string): Promise<void> {
  if (isBuilding(projectId)) return;
  const db = getDb();
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || !["building", "error"].includes(project.status)) return;
  if (!(await resolveLivePreview(project))) return;
  const verifyError = await verifyApp(projectId);
  if (verifyError) return;
  await db.project.update({ where: { id: projectId }, data: { status: "running" } });
  emit(projectId, { type: "project.status", status: "running" });
  emit(projectId, { type: "agent.status", status: "done", message: "Your app is ready." });
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

/** Post-build design + non-negotiables polish. */
async function runDesignPass(
  projectId: string,
  spec: AppSpec,
  state: { cancelled: boolean },
): Promise<string | null> {
  const result = await runDesignPolishPass({
    projectId,
    spec,
    pickModel: (round) => pickAgentModel("build", round),
    runAgent: (choice, messages, doneMarker) =>
      agentLoop(projectId, choice, messages, HEAL_ITERATIONS, state, doneMarker),
    log: (level, text) => logBuild(projectId, level, "system", text),
    status: (s, message) =>
      status(projectId, s === "checking" ? "checking" : "fixing", message),
  });
  return result.verifyError;
}

/** Scan whole app for tap-to-edit anti-patterns; one agent fix round. */
async function runHygienePass(
  projectId: string,
  spec: AppSpec,
  state: { cancelled: boolean },
  phase: "build" | "edit",
): Promise<{ issuesBefore: number; issuesAfter: number; verifyError: string | null } | null> {
  const result = await runTapEditHygienePass({
    projectId,
    spec,
    phase,
    pickModel: (round) => pickAgentModel(phase, round),
    runAgent: (choice, messages, doneMarker) =>
      agentLoop(projectId, choice, messages, HEAL_ITERATIONS, state, doneMarker),
    log: (level, text) => logBuild(projectId, level, "system", text),
    status: (s, message) =>
      status(projectId, s === "checking" ? "checking" : "fixing", message),
  });
  return result;
}

/**
 * The build agent: plan-then-execute tool loop with Metro error self-healing.
 */
/** Absolute ceiling for one build run - past this we fail loudly, never hang. */
const BUILD_DEADLINE_MS = 30 * 60_000;

export async function runBuild(projectId: string): Promise<void> {
  if (activeBuilds.has(projectId)) {
    throw new Error("A build is already running for this project");
  }
  const state = { cancelled: false };
  activeBuilds.set(projectId, state);

  let deadlineHit = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    state.cancelled = true;
    void logBuild(projectId, "error", "system", "Build exceeded the 30 minute deadline - stopping.");
  }, BUILD_DEADLINE_MS);

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
      if (deadlineHit) throw new Error("Build took too long and was stopped automatically");
      await finishCancelled(projectId);
      return;
    }
    if (!finished) {
      await logBuild(projectId, "warn", "system", "Agent hit the iteration limit; proceeding to checks.");
    }

    // Self-heal loop: read Metro logs, fix anything red, repeat.
    for (let round = 1; round <= MAX_HEAL_ROUNDS; round++) {
      if (state.cancelled) {
        if (deadlineHit) throw new Error("Build took too long and was stopped automatically");
        await finishCancelled(projectId);
        return;
      }
      status(projectId, "checking", "Making sure everything works...");
      // Force compile + preview smoke — catches "compiles but dead on launch".
      const verifyError = await verifyApp(projectId);
      const logs = await getProjectLogs(projectId, 150);
      const logErrors = extractErrors(logs);
      const errors = [verifyError, logErrors].filter(Boolean).join("\n---\n") || null;
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
      const healChoice = pickAgentModel("build", round);
      if (env.buildRouting === "mixed" && round >= 2) {
        await logBuild(projectId, "info", "system", `Mixed routing: heal round ${round} on ${healChoice.model}.`);
      }
      await agentLoop(projectId, healChoice, healMessages, HEAL_ITERATIONS, state, "FIX COMPLETE");
    }

    status(projectId, "checking", "Making sure your app actually loads...");
    let launchError = await verifyApp(projectId);
    if (launchError) {
      status(projectId, "fixing", "Fixing a launch issue...");
      await logBuild(projectId, "warn", "system", `Preview smoke failed:\n${launchError}`);
      const healMessages: ChatMessage[] = [
        { role: "system", content: healSystemPrompt(spec) },
        {
          role: "user",
          content: `The app compiles but fails the preview smoke test. Fix it so the app loads in the web preview.\n\n${launchError}`,
        },
      ];
      const healChoice = pickAgentModel("build", MAX_HEAL_ROUNDS + 1);
      if (env.buildRouting === "mixed") {
        await logBuild(projectId, "info", "system", `Mixed routing: launch heal on ${healChoice.model}.`);
      }
      await agentLoop(projectId, healChoice, healMessages, HEAL_ITERATIONS, state, "FIX COMPLETE");
      launchError = await verifyApp(projectId);
      if (launchError) {
        await logBuild(projectId, "warn", "system", `Preview still failing after heal:\n${launchError}`);
      }
    }

    // Post-build: Rule 7 design polish first, then Rule 7b tap-to-edit hygiene (hard gate last).
    const polishError = await runDesignPass(projectId, spec, state);
    if (polishError) {
      await logBuild(projectId, "warn", "system", `Design polish verify: ${polishError}`);
    }

    const hygieneResult = await runHygienePass(projectId, spec, state, "build");
    if (hygieneResult && tapEditAuditBlocked(hygieneResult)) {
      throw new Error(
        `Tap-to-edit hygiene gate failed: ${hygieneResult.issuesAfter} label(s) would not save when tapped — see build log for details.`,
      );
    }
    if (hygieneResult?.verifyError) {
      await logBuild(
        projectId,
        "warn",
        "system",
        `Post-hygiene preview verify failed — one heal round:\n${hygieneResult.verifyError}`,
      );
      status(projectId, "fixing", "Fixing a preview issue...");
      const healMessages: ChatMessage[] = [
        { role: "system", content: healSystemPrompt(spec) },
        {
          role: "user",
          content: `Tap-to-edit hygiene left the app in a state that fails the preview smoke test. Fix it so the app loads in the web preview.\n\n${hygieneResult.verifyError}`,
        },
      ];
      const healChoice = pickAgentModel("build", MAX_HEAL_ROUNDS + 2);
      await agentLoop(projectId, healChoice, healMessages, HEAL_ITERATIONS, state, "FIX COMPLETE");
      const retryError = await verifyApp(projectId);
      if (retryError) {
        await logBuild(
          projectId,
          "warn",
          "system",
          `Preview still failing after post-hygiene heal (build continues):\n${retryError}`,
        );
      } else {
        await logBuild(projectId, "info", "system", "Preview recovered after post-hygiene heal.");
      }
    }

    status(projectId, "checking", "Saving your progress...");
    await createCheckpoint(projectId, "build").catch((err) =>
      logBuild(projectId, "warn", "system", `Checkpoint failed: ${err.message}`),
    );

    await db.project.update({ where: { id: projectId }, data: { status: "running" } });
    emit(projectId, { type: "project.status", status: "running" });
    status(projectId, "done", "Your app is ready!");
    await logBuild(projectId, "info", "system", "Build finished.");
    scheduleBrainstormSnapshotRefresh(projectId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logBuild(projectId, "error", "system", `Build failed: ${message}`);
    await db.project.update({ where: { id: projectId }, data: { status: "error" } }).catch(() => {});
    emit(projectId, { type: "project.status", status: "error" });
    status(projectId, "failed", "Something went wrong building your app.");
  } finally {
    clearTimeout(deadline);
    activeBuilds.delete(projectId);
  }
}

const EDIT_ITERATIONS = 30;

/**
 * Edit mode: the user asked for a change to an already-built app.
 * Pipeline: checkpoint -> surgical agent edit -> bundle verify ->
 * checkpoint on success / hard rollback on failure.
 */
export async function runEdit(
  projectId: string,
  input: string | { agentText: string; storedText?: string },
): Promise<void> {
  const agentText = typeof input === "string" ? input : input.agentText;
  const storedText = typeof input === "string" ? input : (input.storedText ?? input.agentText);
  const request = agentText;
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
    data: { conversationId: conversation.id, role: "user", content: storedText },
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

    // Tap-to-edit color changes only touch the preview DOM via the bridge;
    // patch source directly so the change survives reload.
    if (request.startsWith("[Tap edit]")) {
      const tapPatch = await tryTapEditPatch(projectId, request);
      if (tapPatch.ok) {
        await invalidateMetroBundle(projectId).catch(() => {});
        status(projectId, "checking", "Making sure your app still loads...");
        const verifyError = await verifyApp(projectId);
        if (verifyError) {
          await resetToGitRef(projectId, safeRef);
          await sendEditReply(
            projectId,
            conversation.id,
            "I couldn't apply that change without breaking your app, so I left everything as it was.",
            "tap-edit",
          );
          status(projectId, "idle", "Change rolled back - your app is untouched.");
          return;
        }
        const checkpointId = await createCheckpoint(projectId, `edit: ${request.slice(0, 60)}`).catch(
          (err) => {
            void logBuild(
              projectId,
              "warn",
              "system",
              `Tap edit checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          },
        );
        if (!checkpointId) {
          await sendEditReply(
            projectId,
            conversation.id,
            "Done — your change is in the code, but I couldn't save an undo point for it.",
            "tap-edit",
          );
          status(projectId, "done", "Change saved (no undo point).");
          scheduleBrainstormSnapshotRefresh(projectId);
          return;
        }
        await sendEditReply(projectId, conversation.id, tapPatch.summary, "tap-edit");
        status(projectId, "done", "Change saved.");
        scheduleBrainstormSnapshotRefresh(projectId);
        return;
      }

      await sendEditReply(
        projectId,
        conversation.id,
        "I updated the preview but couldn't save that to your code. Try Undo, then tap again — or describe the change in the chat below.",
        "tap-edit",
      );
      status(projectId, "idle", "Preview only — change wasn't saved to code.");
      return;
    }

    const files = await listProjectFiles(projectId);
    const choice = pickModel("edit");
    const messages: ChatMessage[] = [
      { role: "system", content: editSystemPrompt(spec, files) },
      { role: "user", content: request },
    ];

    status(projectId, "writing", "Making your change...");
    const finished = await agentLoop(projectId, choice, messages, EDIT_ITERATIONS, state, "EDIT COMPLETE");

    // Verify compile + preview smoke; heal up to MAX_HEAL_ROUNDS if not.
    status(projectId, "checking", "Making sure your app still loads...");
    let verifyError = await verifyApp(projectId);
    for (let round = 1; verifyError && round <= MAX_HEAL_ROUNDS; round++) {
      status(projectId, "fixing", "Fixing a small issue...");
      const healChoice = pickAgentModel("edit", round);
      if (env.buildRouting === "mixed" && round >= 2) {
        await logBuild(projectId, "info", "system", `Mixed routing: edit heal round ${round} on ${healChoice.model}.`);
      }
      const healMessages: ChatMessage[] = [
        { role: "system", content: healSystemPrompt(spec) },
        {
          role: "user",
          content: `Your edit broke the app (compile or preview). Fix it.\n\n${verifyError}`,
        },
      ];
      await agentLoop(projectId, healChoice, healMessages, HEAL_ITERATIONS, state, "FIX COMPLETE");
      verifyError = await verifyApp(projectId);
    }

    if (verifyError) {
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

    const hygieneResult = await runHygienePass(projectId, spec, state, "edit");
    if (hygieneResult && tapEditHygieneFailed(hygieneResult)) {
      await resetToGitRef(projectId, safeRef);
      await sendEditReply(
        projectId,
        conversation.id,
        hygieneResult.issuesAfter > 0
          ? "I couldn't save that in a way that keeps every label tappable, so I left your app as it was. Try describing the change in the chat below."
          : "I couldn't make that change without breaking your app, so I left everything as it was. Try describing it a bit differently.",
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
    status(projectId, "done", "Change saved.");
    scheduleBrainstormSnapshotRefresh(projectId);
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
  // Kimi sometimes narrates a plan with no tool calls; nudge it back to
  // work instead of treating that as completion.
  const MAX_NUDGES = 3;
  let nudges = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (state.cancelled) return false;

    // Resilient call: per-attempt timeout, retry, then DeepInfra fallback.
    // A dead provider surfaces as a failed build, never a silent hang.
    const { msg, usedFallback } = await completeChatResilient({
      choice,
      messages,
      tools: agentTools,
      timeoutMs: BUILD_CALL_TIMEOUT_MS,
      onRetry: (attempt, error) => {
        void logBuild(
          projectId,
          "warn",
          "system",
          `Model call attempt ${attempt} failed (${error.slice(0, 160)}); retrying...`,
        );
      },
    });
    if (usedFallback) {
      await logBuild(projectId, "warn", "system", "Primary model unavailable - continuing on backup model.");
    }
    messages.push(msg as ChatMessage);

    if (msg.content) {
      await logBuild(projectId, "info", "agent", msg.content);
    }

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (msg.content?.includes(doneMarker)) return true;
      if (++nudges > MAX_NUDGES) return false;
      messages.push({
        role: "user",
        content: `Continue - execute your plan with tools now. Only reply "${doneMarker}" once everything is actually written and working.`,
      });
      continue;
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
    // Activity timestamp only - a DB blip must never kill a build.
    await touch(projectId).catch(() => {});
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
      status(projectId, "writing", friendlyWriteStatus(String(args.path ?? "")));
      break;
    case "run_command":
      status(projectId, "installing", "Getting everything set up...");
      break;
    case "read_build_logs":
      status(projectId, "checking", "Making sure it all works...");
      break;
    default:
      break;
  }
}

function friendlyWriteStatus(path: string): string {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (p.includes("homescreen") || /home[^/]*\.tsx/.test(p)) {
    return "Setting up your home screen...";
  }
  if (p.includes("screen")) return "Building a new screen...";
  if (p.includes("component") || p.includes("layout")) {
    return "Designing the look and feel...";
  }
  if (p.includes("navigation") || p.includes("router")) {
    return "Connecting your screens...";
  }
  if (p.includes("storage") || p.includes("/data") || p.includes("/lib/")) {
    return "Setting up how your app remembers things...";
  }
  if (p.includes("theme") || p.includes("color") || p.includes("style")) {
    return "Applying your colors and style...";
  }
  return "Bringing your app to life...";
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

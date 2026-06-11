import type { AppSpec } from "@appable/shared";
import type { ChatMessage, ModelChoice } from "../models.js";
import { verifyApp } from "../orchestrator.js";
import {
  auditTapEditReadiness,
  formatTapEditAuditReport,
  type TapEditAuditIssue,
} from "./tapEditAudit.js";
import { tapEditHygieneHealSystemPrompt } from "./prompts.js";

export interface TapEditHygieneContext {
  projectId: string;
  spec: AppSpec;
  /** build = after initial build; edit = after chat/tap edit */
  phase: "build" | "edit";
  pickModel: (round: number) => ModelChoice;
  runAgent: (
    choice: ModelChoice,
    messages: ChatMessage[],
    doneMarker: string,
  ) => Promise<boolean>;
  log: (level: "info" | "warn", text: string) => Promise<void>;
  status: (phase: string, message: string) => void;
}

/**
 * Full-code hygiene pass: scan for tap-to-edit anti-patterns, one agent fix round,
 * re-audit, preview verify. Runs after initial build and after every saved edit.
 */
export async function runTapEditHygienePass(
  ctx: TapEditHygieneContext,
): Promise<{ issuesBefore: number; issuesAfter: number; verifyError: string | null }> {
  let issues = await auditTapEditReadiness(ctx.projectId);
  if (issues.length === 0) {
    return { issuesBefore: 0, issuesAfter: 0, verifyError: null };
  }

  const before = issues.length;
  ctx.status("fixing", "Checking labels save correctly when tapped...");
  await ctx.log("info", formatTapEditAuditReport(issues));

  const healMessages: ChatMessage[] = [
    { role: "system", content: tapEditHygieneHealSystemPrompt(ctx.spec) },
    {
      role: "user",
      content: [
        "The hygiene audit found tap-to-edit problems in the codebase.",
        "Fix EVERY item below so customers can tap any label and have it save to code.",
        "Follow rule 7b from the build contract — smallest edits only.",
        "",
        formatTapEditAuditReport(issues, 40),
      ].join("\n"),
    },
  ];

  const choice = ctx.pickModel(1);
  await ctx.runAgent(choice, healMessages, "FIX COMPLETE");

  const recheck = await auditTapEditReadiness(ctx.projectId);
  issues = recheck;
  if (recheck.length > 0) {
    await ctx.log(
      "warn",
      `Tap-edit hygiene: ${recheck.length} issue(s) remain after fix pass.`,
    );
    await ctx.log("warn", formatTapEditAuditReport(recheck, 15));
  } else {
    await ctx.log("info", "Tap-edit hygiene: all checks passed.");
  }

  ctx.status("checking", "Making sure your app still loads...");
  const verifyError = await verifyApp(ctx.projectId);
  if (verifyError) {
    await ctx.log("warn", `Post hygiene verify: ${verifyError}`);
  }

  return { issuesBefore: before, issuesAfter: recheck.length, verifyError };
}

export type { TapEditAuditIssue };

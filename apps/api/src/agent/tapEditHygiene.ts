import type { AppSpec } from "@appable/shared";
import type { ChatMessage, ModelChoice } from "../models.js";
import { verifyApp } from "../orchestrator.js";
import {
  auditTapEditReadiness,
  formatTapEditAuditReport,
  type TapEditAuditIssue,
} from "./tapEditAudit.js";
import { formatTapEditProbeReport, probeTapEditSave } from "./tapEditProbe.js";
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
  let auditIssues = await auditTapEditReadiness(ctx.projectId);
  const before = auditIssues.length;

  if (auditIssues.length > 0) {
    ctx.status("fixing", "Checking labels save correctly when tapped...");
    await ctx.log("info", formatTapEditAuditReport(auditIssues));

    const healMessages: ChatMessage[] = [
      { role: "system", content: tapEditHygieneHealSystemPrompt(ctx.spec) },
      {
        role: "user",
        content: [
          "The hygiene audit found tap-to-edit problems in the codebase.",
          "Fix EVERY item below so customers can tap any label and have it save to code.",
          "Follow rule 7b from the build contract — smallest edits only.",
          "",
          formatTapEditAuditReport(auditIssues, 40),
        ].join("\n"),
      },
    ];

    const choice = ctx.pickModel(1);
    await ctx.runAgent(choice, healMessages, "FIX COMPLETE");

    auditIssues = await auditTapEditReadiness(ctx.projectId);
    if (auditIssues.length > 0) {
      await ctx.log("info", "Tap-edit hygiene: second fix pass for remaining issues.");
      const choice2 = ctx.pickModel(2);
      await ctx.runAgent(
        choice2,
        [
          { role: "system", content: tapEditHygieneHealSystemPrompt(ctx.spec) },
          {
            role: "user",
            content: [
              "Some tap-to-edit issues remain after the first pass. Fix ALL of them.",
              "",
              formatTapEditAuditReport(auditIssues, 40),
            ].join("\n"),
          },
        ],
        "FIX COMPLETE",
      );
      auditIssues = await auditTapEditReadiness(ctx.projectId);
    }

    if (auditIssues.length > 0) {
      await ctx.log(
        "warn",
        `Tap-edit hygiene: ${auditIssues.length} static audit issue(s) remain after fix pass.`,
      );
      await ctx.log("warn", formatTapEditAuditReport(auditIssues, 15));
    } else {
      await ctx.log("info", "Tap-edit hygiene: static audit passed.");
    }
  }

  ctx.status("checking", "Verifying tapped labels would save to code...");
  const probeFailures = await probeTapEditSave(ctx.projectId);
  if (probeFailures.length > 0) {
    await ctx.log(
      "warn",
      `Tap-edit save probe: ${probeFailures.length} label(s) would not persist.`,
    );
    await ctx.log("warn", formatTapEditProbeReport(probeFailures, 15));
  } else {
    await ctx.log("info", formatTapEditProbeReport(probeFailures));
  }

  const issuesAfter = auditIssues.length + probeFailures.length;

  ctx.status("checking", "Making sure your app still loads...");
  const verifyError = await verifyApp(ctx.projectId);
  if (verifyError) {
    await ctx.log("warn", `Post hygiene verify: ${verifyError}`);
  }

  return { issuesBefore: before, issuesAfter, verifyError };
}

/** Build gate: static audit still reports unsaveable labels after fix passes. */
export function tapEditAuditBlocked(result: { issuesAfter: number }): boolean {
  return result.issuesAfter > 0;
}

/** Edit rollback: audit issues or preview verify failed after hygiene. */
export function tapEditHygieneFailed(result: {
  issuesAfter: number;
  verifyError: string | null;
}): boolean {
  return result.issuesAfter > 0 || result.verifyError !== null;
}

export type { TapEditAuditIssue };

import type { AppSpec } from "@appable/shared";
import type { ChatMessage, ModelChoice } from "../models.js";
import { verifyApp } from "../orchestrator.js";
import { auditDesignQuality, formatDesignAuditReport } from "./designAudit.js";
import { designPolishUserMessage } from "./codeDiscipline.js";
import { designPolishHealSystemPrompt } from "./prompts.js";

export interface DesignPolishContext {
  projectId: string;
  spec: AppSpec;
  pickModel: (round: number) => ModelChoice;
  runAgent: (
    choice: ModelChoice,
    messages: ChatMessage[],
    doneMarker: string,
  ) => Promise<boolean>;
  log: (level: "info" | "warn", text: string) => Promise<void>;
  status: (phase: string, message: string) => void;
}

/** Post-build pass: non-negotiables + anti-slop design fixes. */
export async function runDesignPolishPass(
  ctx: DesignPolishContext,
): Promise<{ issuesBefore: number; issuesAfter: number; verifyError: string | null }> {
  let issues = await auditDesignQuality(ctx.projectId, ctx.spec);
  const critical = issues.filter((i) =>
    [
      "missing-sign-in",
      "missing-sign-out",
      "missing-delete-account",
      "missing-role-picker",
      "missing-auth-module",
      "missing-storage-module",
      "missing-base-components",
    ].includes(i.kind),
  );

  if (issues.length === 0) {
    return { issuesBefore: 0, issuesAfter: 0, verifyError: null };
  }

  const before = issues.length;
  ctx.status("fixing", "Polishing the look and required features...");
  await ctx.log("info", `Design audit:\n${formatDesignAuditReport(issues, 25)}`);

  const healMessages: ChatMessage[] = [
    { role: "system", content: designPolishHealSystemPrompt(ctx.spec) },
    {
      role: "user",
      content: designPolishUserMessage(formatDesignAuditReport(issues, 40)),
    },
  ];

  if (critical.length > 0) {
    healMessages.push({
      role: "user",
      content:
        "CRITICAL: sign-in, sign-out, delete account, and role picker (if two-sided) are mandatory. Fix these first.",
    });
  }

  const choice = ctx.pickModel(1);
  await ctx.runAgent(choice, healMessages, "FIX COMPLETE");

  const recheck = await auditDesignQuality(ctx.projectId, ctx.spec);
  issues = recheck;
  if (recheck.length > 0) {
    await ctx.log("warn", `Design polish: ${recheck.length} issue(s) remain.`);
    await ctx.log("warn", formatDesignAuditReport(recheck, 15));
  } else {
    await ctx.log("info", "Design polish: all checks passed.");
  }

  ctx.status("checking", "Making sure your app still loads...");
  const verifyError = await verifyApp(ctx.projectId);
  if (verifyError) {
    await ctx.log("warn", `Post polish verify: ${verifyError}`);
  }

  return { issuesBefore: before, issuesAfter: recheck.length, verifyError };
}

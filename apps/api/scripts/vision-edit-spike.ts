/**
 * Spike: screenshot → cheap vision UI audit → MiniMax edit → verify.
 * Usage: npx tsx apps/api/scripts/vision-edit-spike.ts <projectId> <screenshot.png>
 */
import fs from "node:fs";
import { completeChat, pickVisionModel, type ChatMessage } from "../src/models.js";
import { runEdit } from "../src/agent/loop.js";
import { verifyApp, repairPlatformGlue } from "../src/orchestrator.js";

const projectId = process.argv[2];
const screenshotPath = process.argv[3];
if (!projectId || !screenshotPath) {
  console.error("Usage: npx tsx apps/api/scripts/vision-edit-spike.ts <projectId> <screenshot.png>");
  process.exit(1);
}

const image = fs.readFileSync(screenshotPath);
const dataUrl = `data:image/png;base64,${image.toString("base64")}`;

const visionPrompt = `You are a mobile UI QA reviewer. This screenshot is a React Native app preview (MealMingle — meal planning app).

List ONLY concrete visual bugs a customer would notice (max 5). Be specific about location.
Format each as: - [severity: low|medium|high] issue → suggested fix (spacing, color, copy, alignment, empty area, etc.)

Do NOT suggest new features. Do NOT mention code files unless obvious.
End with one line: OVERALL: pass | needs-polish | poor`;

async function visionAudit(): Promise<string> {
  const choice = pickVisionModel();
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: visionPrompt },
      ],
    },
  ];
  const msg = await completeChat({ choice, messages, maxTokens: 800, timeoutMs: 90_000 });
  const text = typeof msg.content === "string" ? msg.content.trim() : "";
  if (!text) throw new Error("Vision model returned empty response");
  console.log("\n=== VISION AUDIT ===\n");
  console.log(text);
  return text;
}

async function main(): Promise<void> {
  await repairPlatformGlue(projectId);

  const audit = await visionAudit();

  if (/OVERALL:\s*pass\b/i.test(audit)) {
    console.log("\nVision says pass — skipping edit.");
    return;
  }

  const editRequest = `[Vision QA polish] Fix these visual issues from a screenshot review. Smallest UI-only changes — spacing, typography, colors from tokens.ts, copy tweaks. Do not refactor architecture.

${audit}`;

  console.log("\n=== RUNNING MINIMAX EDIT ===\n");
  await runEdit(projectId, editRequest);

  const verifyError = await verifyApp(projectId);
  console.log("\n=== AFTER EDIT ===");
  console.log(verifyError ? `Verify: ${verifyError}` : "Verify: bundle OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

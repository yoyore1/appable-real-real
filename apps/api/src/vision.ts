import type { ChatAttachment } from "@appable/shared";
import { readAttachmentBytes } from "./attachments.js";
import { completeChat, pickVisionModel, type ChatMessage } from "./models.js";

/**
 * MiniMax M2.7 (our edit/build model) is text-only. When the user attaches
 * reference photos, a vision model describes them first; that text is passed
 * to the edit agent.
 */
export async function enrichWithVisionContext(
  projectId: string,
  userText: string,
  attachments: ChatAttachment[],
): Promise<string> {
  if (!attachments.length) return userText;

  const descriptions: string[] = [];
  const choice = pickVisionModel();

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]!;
    const file = await readAttachmentBytes(projectId, att.id);
    if (!file) {
      descriptions.push(`Image ${i + 1} (${att.name}): could not be read.`);
      continue;
    }

    const dataUrl = `data:${file.mime};base64,${file.data.toString("base64")}`;
    const prompt =
      attachments.length === 1
        ? `The user attached a reference photo for their app. Describe what you see in detail — colors, layout, typography, UI elements, icons, spacing, mood. Then explain how it could guide an app design change. User message: "${userText || "See attached image"}"`
        : `Reference photo ${i + 1} of ${attachments.length} (${att.name}). Describe colors, layout, typography, UI elements, icons, spacing, and mood. User message: "${userText || "See attached images"}"`;

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: prompt },
        ],
      },
    ];

    try {
      const msg = await completeChat({
        choice,
        messages,
        maxTokens: 900,
        timeoutMs: 60_000,
      });
      const text =
        typeof msg.content === "string" ? msg.content.trim() : "";
      descriptions.push(
        text
          ? `Image ${i + 1} (${att.name}):\n${text}`
          : `Image ${i + 1} (${att.name}): no description returned.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      descriptions.push(`Image ${i + 1} (${att.name}): vision failed (${message}).`);
    }
  }

  const header =
    attachments.length === 1
      ? "[User attached 1 reference photo — use this visual description when making the change]"
      : `[User attached ${attachments.length} reference photos — use these visual descriptions when making the change]`;

  return `${userText}\n\n${header}\n\n${descriptions.join("\n\n")}`;
}

/** Reference image attached to a chat message (photos only — no video). */
export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  /** Authenticated URL the API serves the file from. */
  url: string;
}

const MARKER = "<!--appable-attachments:";

export function encodeMessageWithAttachments(
  text: string,
  attachments: ChatAttachment[],
): string {
  if (!attachments.length) return text;
  return `${text}\n\n${MARKER}${JSON.stringify(attachments)}-->`;
}

export function decodeMessageWithAttachments(content: string): {
  text: string;
  attachments: ChatAttachment[];
} {
  const idx = content.lastIndexOf(MARKER);
  if (idx === -1) return { text: content, attachments: [] };
  const end = content.indexOf("-->", idx);
  if (end === -1) return { text: content, attachments: [] };
  try {
    const raw = content.slice(idx + MARKER.length, end);
    const attachments = JSON.parse(raw) as ChatAttachment[];
    if (!Array.isArray(attachments)) return { text: content, attachments: [] };
    const text = content.slice(0, idx).trimEnd();
    return { text, attachments };
  } catch {
    return { text: content, attachments: [] };
  }
}

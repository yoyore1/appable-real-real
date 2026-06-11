import type { ChatAttachment } from "@appable/shared";
import { decodeMessageWithAttachments } from "@appable/shared";
import { getToken } from "./api.js";

/** Load an authenticated attachment as a blob URL for <img src>. */
export async function fetchAttachmentBlobUrl(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  });
  if (!res.ok) throw new Error("Could not load image");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function parseChatMessage(content: string): {
  text: string;
  attachments: ChatAttachment[];
} {
  return decodeMessageWithAttachments(content);
}

export async function uploadChatAttachment(
  projectId: string,
  file: File,
): Promise<ChatAttachment> {
  const data = await fileToBase64(file);
  const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
  const res = await fetch(`${API_BASE}/projects/${projectId}/attachments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: JSON.stringify({ name: file.name, mime: file.type, data }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "Upload failed");
  }
  return res.json() as Promise<ChatAttachment>;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

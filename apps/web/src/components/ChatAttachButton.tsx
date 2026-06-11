import { useRef } from "react";
import type { ChatAttachment } from "@appable/shared";
import { HoverTip } from "./HoverTip.js";

const MAX_FILES = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function ChatAttachButton({
  disabled,
  count,
  onPick,
  onError,
}: {
  disabled?: boolean;
  count: number;
  onPick: (files: File[]) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function openPicker() {
    if (disabled || count >= MAX_FILES) return;
    inputRef.current?.click();
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const list = [...(e.target.files ?? [])];
    e.target.value = "";
    if (!list.length) return;

    const valid: File[] = [];
    for (const file of list) {
      if (file.type.startsWith("video/")) {
        onError("Videos aren't supported — add a photo instead.");
        continue;
      }
      if (!ALLOWED.has(file.type)) {
        onError("Use a JPG, PNG, WebP, or GIF photo.");
        continue;
      }
      if (file.size > MAX_BYTES) {
        onError(`${file.name} is too large (max 5 MB).`);
        continue;
      }
      valid.push(file);
    }

    const room = MAX_FILES - count;
    if (valid.length > room) {
      onError(`You can attach up to ${MAX_FILES} photos.`);
      onPick(valid.slice(0, room));
      return;
    }
    if (valid.length) onPick(valid);
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        hidden
        onChange={onChange}
      />
      <HoverTip text="Add a photo (no videos)">
        <button
          type="button"
          className="icon-btn chat-attach"
          aria-label="Add photo"
          disabled={disabled || count >= MAX_FILES}
          onClick={openPicker}
        >
          <AttachIcon />
        </button>
      </HoverTip>
    </>
  );
}

function AttachIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export type PendingAttachment = ChatAttachment & { previewUrl: string };

import { useCallback } from "react";
import { useSpeechInput } from "../speech.js";
import { HoverTip } from "./HoverTip.js";

export function MicButton({
  onTranscript,
  tip = "Speak your idea — we'll handle the rest.",
  disabled = false,
  className = "icon-btn",
}: {
  onTranscript: (text: string) => void;
  tip?: string;
  disabled?: boolean;
  className?: string;
}) {
  const append = useCallback(
    (chunk: string) => onTranscript(chunk),
    [onTranscript],
  );
  const { recording, toggle, supported } = useSpeechInput(append);

  if (!supported) return null;

  return (
    <HoverTip
      text={recording ? "Stop listening" : tip}
      delayMs={1000}
    >
      <button
        type="button"
        className={recording ? `${className} recording` : className}
        onClick={toggle}
        disabled={disabled}
        aria-label={recording ? "Stop listening" : "Speak"}
        aria-pressed={recording}
      >
        {recording ? <StopIcon /> : <MicIcon />}
      </button>
    </HoverTip>
  );
}

function MicIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

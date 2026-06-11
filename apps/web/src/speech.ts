import { useCallback, useMemo, useRef, useState } from "react";

/** Web Speech API (Chrome/Edge). Typed loosely — not in standard lib. */
type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
};

export function getSpeechRecognition(): (new () => SpeechRec) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRec) | null;
}

/** Toggle mic and append recognized speech to a string field. */
export function useSpeechInput(onAppend: (chunk: string) => void) {
  const [recording, setRecording] = useState(false);
  const recRef = useRef<SpeechRec | null>(null);
  const supported = useMemo(() => getSpeechRecognition() !== null, []);

  const toggle = useCallback(() => {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    const Rec = getSpeechRecognition();
    if (!Rec) return;
    const rec = new Rec();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      if (text.trim()) onAppend(text.trim());
    };
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    recRef.current = rec;
    setRecording(true);
    rec.start();
  }, [onAppend, recording]);

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  return { recording, toggle, stop, supported };
}

import { useLayoutEffect, useRef } from "react";

/** Keeps a chat column pinned to the bottom as messages stream in. */
export function useChatScroll(tail: string) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [tail]);

  return scrollRef;
}

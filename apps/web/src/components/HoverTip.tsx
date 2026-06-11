import { useEffect, useRef, useState, type ReactNode } from "react";

interface HoverTipProps {
  children: ReactNode;
  text: string;
  /** ms before the tip fades in */
  delayMs?: number;
  side?: "top" | "bottom";
  /** Wider tip for longer copy */
  wide?: boolean;
}

export function HoverTip({
  children,
  text,
  delayMs = 1000,
  side = "top",
  wide = false,
}: HoverTipProps) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | null>(null);

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function showLater() {
    clearTimer();
    timerRef.current = window.setTimeout(() => setMounted(true), delayMs);
  }

  function hide() {
    clearTimer();
    setVisible(false);
    window.setTimeout(() => setMounted(false), 220);
  }

  useEffect(() => {
    if (!mounted) {
      setVisible(false);
      return;
    }
    const id = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(id);
  }, [mounted]);

  useEffect(() => () => clearTimer(), []);

  return (
    <span
      className="hover-tip-wrap"
      onMouseEnter={showLater}
      onMouseLeave={hide}
      onFocus={showLater}
      onBlur={hide}
    >
      {children}
      {mounted && (
        <span
          className={[
            "hover-tip",
            `hover-tip-${side}`,
            visible ? "on" : "",
            wide ? "hover-tip-wide" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="tooltip"
        >
          {text}
        </span>
      )}
    </span>
  );
}

import { useEffect, useId, useState, type ReactNode } from "react";

export function SidePanel({
  title,
  children,
  defaultOpen = false,
  autoOpenWhen,
  badge,
  badgeTone = "ready",
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Opens the panel when this flips true (e.g. QR ready). */
  autoOpenWhen?: boolean;
  badge?: string;
  badgeTone?: "ready" | "muted";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  useEffect(() => {
    if (autoOpenWhen) setOpen(true);
  }, [autoOpenWhen]);

  return (
    <div className={`side-panel${open ? " open" : ""}`}>
      <button
        type="button"
        className="side-panel-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="side-panel-title">{title}</span>
        {badge && !open && (
          <span
            className={
              badgeTone === "muted" ? "side-panel-badge muted" : "side-panel-badge"
            }
          >
            {badge}
          </span>
        )}
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div id={bodyId} className="side-panel-body">
          <div className="side-panel-inner">{children}</div>
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? "side-panel-chevron open" : "side-panel-chevron"}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

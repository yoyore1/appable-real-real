import { useEffect, useRef, useState } from "react";
import type { AgentStatusEvent, BuildEventEvent } from "@appable/shared";

interface BuildProgressInput {
  /** True while project.status === "building" (initial build only). */
  active: boolean;
  agentStatus: AgentStatusEvent | null;
  buildLog: BuildEventEvent[];
  previewReady: boolean;
  /** From spec — used to estimate how many files the agent will write. */
  expectedScreens?: number;
}

/**
 * Approximate, monotonic build progress (0–100) for the initial build.
 * Driven by agent phase, files written, preview readiness, and gentle
 * time-based creep so the bar never looks frozen.
 */
export function useBuildProgress({
  active,
  agentStatus,
  buildLog,
  previewReady,
  expectedScreens = 4,
}: BuildProgressInput): number {
  const [display, setDisplay] = useState(0);
  const targetRef = useRef(0);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      if (agentStatus?.status === "done" || previewReady) {
        targetRef.current = 100;
      } else {
        targetRef.current = 0;
        startedAt.current = null;
        setDisplay(0);
      }
      return;
    }

    if (startedAt.current === null) startedAt.current = Date.now();
    const elapsedMs = Date.now() - startedAt.current;

    const status = agentStatus?.status ?? "planning";
    if (status === "done") {
      targetRef.current = 100;
      return;
    }

    const filesWritten = buildLog.filter((e) => e.text.startsWith("wrote ")).length;
    const expectedFiles = Math.max(8, expectedScreens * 2 + 4);

    let target: number;
    switch (status) {
      case "planning":
        target = 6 + Math.min(12, elapsedMs / 2500);
        break;
      case "writing":
        target = 18 + (filesWritten / expectedFiles) * 56;
        break;
      case "installing":
        target = 74;
        break;
      case "checking":
        target = 84 + Math.min(8, filesWritten / expectedFiles) * 4;
        break;
      case "fixing":
        target = 92;
        break;
      default:
        target = 8;
    }

    const phaseCeil: Record<string, number> = {
      planning: 20,
      writing: 78,
      installing: 80,
      checking: 94,
      fixing: 98,
    };
    const ceil = phaseCeil[status] ?? 96;
    target = Math.min(ceil, target);

    if (previewReady) target = Math.max(target, 97);

    // Gentle creep so early planning never sits at 0%.
    const timeFloor = Math.min(ceil - 1, 2 + elapsedMs / 2000);
    target = Math.max(target, timeFloor);

    targetRef.current = Math.max(targetRef.current, Math.min(99, target));
  }, [active, agentStatus, buildLog, previewReady, expectedScreens]);

  useEffect(() => {
    if (!active && targetRef.current < 100) return;

    const id = window.setInterval(() => {
      setDisplay((prev) => {
        const target = targetRef.current;
        if (prev >= 100) return 100;
        if (prev >= target) {
          if (!active && target >= 100) return 100;
          // Slow drift while waiting on the same phase.
          const driftCap = active ? Math.min(99, target + 1.5) : target;
          if (prev < driftCap) return Math.min(driftCap, prev + 0.06);
          return prev;
        }
        const gap = target - prev;
        const step = gap > 12 ? 1.4 : gap > 4 ? 0.55 : 0.18;
        return Math.min(target, prev + step);
      });
    }, 70);

    return () => clearInterval(id);
  }, [active]);

  return Math.round(display);
}

/**
 * Tap-to-edit runtime data layer.
 *
 * Design goal: the build agent NEVER hardcodes text, color, fontSize, or
 * background on any element the user might want to edit. Instead it uses
 * <EditableText />, <EditableIcon />, and <EditableBackground /> from the
 * template. Those components:
 *   - register themselves on mount (testID -> source path + current value)
 *   - read their display values from this shared override store
 *   - re-render automatically when the store changes
 *
 * The API tap-edit endpoint therefore does NOT patch source code. It just
 * mutates `setOverride(testID, patch)` and writes the result to AsyncStorage.
 * The app re-renders in ~16ms. No bundle, no verify, no git, no patcher.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type OverrideKey = string;

export type OverrideValue = {
  text?: string;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  fontWeight?: "400" | "500" | "600" | "700" | "normal" | "bold";
  fontFamily?: string;
};

export type RegisteredElement = {
  testID: string;
  /** Which file/property this value originally came from (for persistence/debug). */
  source: { file: string; export: string; property?: string };
  /** Current value BEFORE overrides are applied. */
  defaultValue: OverrideValue;
  /** Latest committed override value (may be identical to default). */
  value: OverrideValue;
};

const STORAGE_KEY = "@appable/tap-edit-overrides";

const registry = new Map<string, RegisteredElement>();
const listeners = new Set<() => void>();
let committedOverrides: Record<OverrideKey, OverrideValue> = {};

/** Expose registry + setter to the web bridge for component-side hit-testing. */
if (typeof window !== "undefined") {
  const w = window as typeof window & {
    __appableTapEditRegistry?: Map<string, RegisteredElement>;
    __appableSetOverride?: (testID: string, patch: OverrideValue) => boolean;
  };
  w.__appableTapEditRegistry = registry;
  w.__appableSetOverride = setOverride;
}

function notify() {
  for (const cb of listeners) cb();
}

export function registerElement(testID: string, spec: Omit<RegisteredElement, "value">) {
  const existing = registry.get(testID);
  const value = committedOverrides[testID] ?? {};
  registry.set(testID, { ...spec, value });
  // If the element re-mounts (e.g. navigation), keep any live override.
  if (existing && Object.keys(existing.value).length > 0) {
    registry.get(testID)!.value = existing.value;
  }
  notify();
}

export function unregisterElement(testID: string) {
  // Do NOT delete from registry while editing; just mark unmounted if needed.
  // Keeping registration lets the tap UI find elements across screens.
}

export function getRegisteredElement(testID: string): RegisteredElement | undefined {
  return registry.get(testID);
}

export function getAllRegisteredElements(): RegisteredElement[] {
  return [...registry.values()];
}

export function setOverride(testID: string, patch: OverrideValue) {
  const el = registry.get(testID);
  if (!el) return false;
  el.value = { ...el.value, ...patch };
  committedOverrides = { ...committedOverrides, [testID]: el.value };
  notify();
  void persistOverrides();
  return true;
}

export function resetOverride(testID: string) {
  const el = registry.get(testID);
  if (!el) return false;
  el.value = {};
  const next = { ...committedOverrides };
  delete next[testID];
  committedOverrides = next;
  notify();
  void persistOverrides();
  return true;
}

async function persistOverrides() {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(committedOverrides));
  } catch {
    // ignore
  }
}

export async function loadOverrides(): Promise<Record<OverrideKey, OverrideValue>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      committedOverrides = JSON.parse(raw) as Record<OverrideKey, OverrideValue>;
      // Re-apply to already-registered elements.
      for (const [testID, value] of Object.entries(committedOverrides)) {
        const el = registry.get(testID);
        if (el) el.value = value;
      }
      notify();
    }
  } catch {
    // ignore
  }
  return committedOverrides;
}

// React integration ---------------------------------------------------------

const TapEditContext = createContext<{
  overrides: Record<OverrideKey, OverrideValue>;
  setOverride: (testID: string, patch: OverrideValue) => boolean;
  resetOverride: (testID: string) => boolean;
  getElement: (testID: string) => RegisteredElement | undefined;
} | null>(null);

export function TapEditProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, []);

  const value = useMemo(
    () => ({
      overrides: committedOverrides,
      setOverride,
      resetOverride,
      getElement: getRegisteredElement,
    }),
    [tick],
  );

  return <TapEditContext.Provider value={value}>{children}</TapEditContext.Provider>;
}

export function useTapEdit() {
  const ctx = useContext(TapEditContext);
  if (!ctx) throw new Error("useTapEdit must be inside TapEditProvider");
  return ctx;
}

export function useEditableValue(testID: string, defaultValue: OverrideValue) {
  const ctx = useTapEdit();
  const override = ctx.overrides[testID] ?? {};
  return useMemo(
    () => ({ ...defaultValue, ...override }),
    [defaultValue, override],
  );
}

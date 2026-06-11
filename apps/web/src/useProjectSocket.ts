import { useEffect, useRef, useState, useCallback } from "react";
import type {
  AgentStatusEvent,
  AppSpec,
  BuildEventEvent,
  ClientMessage,
  PreviewStatusEvent,
  ProjectStatus,
  ServerEvent,
} from "@appable/shared";
import { wsUrl } from "./api.js";

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

export interface ProjectSocketState {
  connected: boolean;
  projectStatus: ProjectStatus | null;
  agentStatus: AgentStatusEvent | null;
  preview: PreviewStatusEvent | null;
  spec: AppSpec | null;
  buildLog: BuildEventEvent[];
  interview: ChatItem[];
  brainstorm: ChatItem[];
  build: ChatItem[];
  /** Tap-to-answer chips for the current interview question. */
  interviewSuggestions: {
    messageId: string;
    items: string[];
    mode: "answer" | "wrapup";
  } | null;
  /** Bumps when a new checkpoint is saved (for undo button state). */
  checkpointsVersion: number;
  send: (msg: ClientMessage) => void;
  appendLocal: (kind: "interview" | "brainstorm" | "build", text: string) => void;
  seed: (kind: "interview" | "brainstorm" | "build", items: ChatItem[]) => void;
  clearInterviewSuggestions: () => void;
}

export function useProjectSocket(projectId: string | null): ProjectSocketState {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatusEvent | null>(null);
  const [preview, setPreview] = useState<PreviewStatusEvent | null>(null);
  const [spec, setSpec] = useState<AppSpec | null>(null);
  const [buildLog, setBuildLog] = useState<BuildEventEvent[]>([]);
  const [interview, setInterview] = useState<ChatItem[]>([]);
  const [brainstorm, setBrainstorm] = useState<ChatItem[]>([]);
  const [build, setBuild] = useState<ChatItem[]>([]);
  const [interviewSuggestions, setInterviewSuggestions] = useState<{
    messageId: string;
    items: string[];
    mode: "answer" | "wrapup";
  } | null>(null);
  const [checkpointsVersion, setCheckpointsVersion] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    setBuildLog([]);
    setInterview([]);
    setBrainstorm([]);
    setBuild([]);
    setSpec(null);
    setPreview(null);
    setAgentStatus(null);
    setInterviewSuggestions(null);
    setCheckpointsVersion(0);

    const ws = new WebSocket(wsUrl(projectId));
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as ServerEvent;
      handleEvent(event);
    };

    function pickSetter(kind: "interview" | "brainstorm" | "build") {
      if (kind === "interview") return setInterview;
      if (kind === "brainstorm") return setBrainstorm;
      return setBuild;
    }

    function handleEvent(event: ServerEvent): void {
      switch (event.type) {
        case "chat.suggestions":
          if (event.conversation === "interview") {
            setInterviewSuggestions({
              messageId: event.messageId,
              items: event.suggestions,
              mode: event.mode ?? "answer",
            });
          }
          break;
        case "chat.delta": {
          const setter = pickSetter(event.conversation);
          setter((items) => {
            const existing = items.find((i) => i.id === event.messageId);
            if (existing) {
              return items.map((i) =>
                i.id === event.messageId
                  ? { ...i, text: (i.text + event.delta).trimStart() }
                  : i,
              );
            }
            return [
              ...items,
              {
                id: event.messageId,
                role: "assistant",
                text: event.delta.trimStart(),
                streaming: true,
              },
            ];
          });
          break;
        }
        case "chat.done": {
          const setter = pickSetter(event.conversation);
          const text = event.text.trim();
          setter((items) => {
            const exists = items.some((i) => i.id === event.messageId);
            if (!exists) {
              return [...items, { id: event.messageId, role: "assistant", text }];
            }
            return items.map((i) =>
              i.id === event.messageId ? { ...i, text, streaming: false } : i,
            );
          });
          break;
        }
        case "agent.status":
          setAgentStatus(event);
          break;
        case "build.event":
          setBuildLog((log) => [...log.slice(-400), event]);
          break;
        case "file.op":
          setBuildLog((log) => [
            ...log.slice(-400),
            {
              type: "build.event",
              level: "info",
              source: "agent",
              text: `${event.op === "write" ? "wrote" : "deleted"} ${event.path}`,
              timestamp: new Date().toISOString(),
            },
          ]);
          break;
        case "preview.status":
          setPreview(event);
          break;
        case "spec.updated":
          setSpec(event.spec);
          break;
        case "project.status":
          setProjectStatus((prev) => {
            if (prev === "building" && event.status !== "building") {
              setBuildLog([]);
            }
            return event.status;
          });
          break;
        case "checkpoint.created":
          setCheckpointsVersion((n) => n + 1);
          break;
        case "error":
          setBuildLog((log) => [
            ...log.slice(-400),
            {
              type: "build.event",
              level: "error",
              source: "system",
              text: event.message,
              timestamp: new Date().toISOString(),
            },
          ]);
          break;
        default:
          break;
      }
    }

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [projectId]);

  const send = useCallback((msg: ClientMessage) => {
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  const appendLocal = useCallback(
    (kind: "interview" | "brainstorm" | "build", text: string) => {
      const item: ChatItem = { id: `local-${Date.now()}`, role: "user", text };
      if (kind === "interview") setInterview((i) => [...i, item]);
      else if (kind === "brainstorm") setBrainstorm((i) => [...i, item]);
      else setBuild((i) => [...i, item]);
    },
    [],
  );

  const seed = useCallback(
    (kind: "interview" | "brainstorm" | "build", items: ChatItem[]) => {
      if (kind === "interview") setInterview(items);
      else if (kind === "brainstorm") setBrainstorm(items);
      else setBuild(items);
    },
    [],
  );

  const clearInterviewSuggestions = useCallback(() => {
    setInterviewSuggestions(null);
  }, []);

  return {
    connected,
    projectStatus,
    agentStatus,
    preview,
    spec,
    buildLog,
    interview,
    brainstorm,
    build,
    interviewSuggestions,
    checkpointsVersion,
    send,
    appendLocal,
    seed,
    clearInterviewSuggestions,
  };
}

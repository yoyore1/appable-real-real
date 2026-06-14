import type { AppSpec, ProjectStatus } from "./spec.js";
import type { ChatAttachment } from "./chatAttachments.js";

/**
 * Realtime protocol: one WebSocket per open project.
 * Client -> Server messages and Server -> Client events.
 * Every feature (interview chat, brainstorm, build streaming, preview
 * readiness) rides this single typed protocol.
 */

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | ChatSendMessage
  | BuildStartMessage
  | BuildCancelMessage
  | CheckpointRestoreMessage
  | PingMessage;

export interface ChatSendMessage {
  type: "chat.send";
  /** Which conversation this belongs to. */
  conversation: "interview" | "brainstorm" | "build";
  text: string;
  /** Optional reference photos (images only). */
  attachments?: ChatAttachment[];
}

export type { ChatAttachment } from "./chatAttachments.js";

export interface BuildStartMessage {
  type: "build.start";
}

export interface BuildCancelMessage {
  type: "build.cancel";
}

export interface CheckpointRestoreMessage {
  type: "checkpoint.restore";
  checkpointId: string;
}

export interface PingMessage {
  type: "ping";
}

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerEvent =
  | ChatDeltaEvent
  | ChatSuggestionsEvent
  | ChatDoneEvent
  | AgentStatusEvent
  | BuildEventEvent
  | FileOpEvent
  | PreviewStatusEvent
  | SpecUpdatedEvent
  | ProjectStatusEvent
  | CheckpointCreatedEvent
  | TapEditApplyEvent
  | ErrorEvent
  | PongEvent;

/** Streaming token(s) of an assistant reply. */
export interface ChatDeltaEvent {
  type: "chat.delta";
  conversation: "interview" | "brainstorm" | "build";
  messageId: string;
  delta: string;
}

/** Tap-to-answer suggestions shown with the assistant message. */
export interface ChatSuggestionsEvent {
  type: "chat.suggestions";
  conversation: "interview" | "brainstorm" | "build";
  messageId: string;
  suggestions: string[];
  /** answer = pick options for a question; wrapup = final summary actions */
  mode?: "answer" | "wrapup";
}

/** Assistant reply finished. */
export interface ChatDoneEvent {
  type: "chat.done";
  conversation: "interview" | "brainstorm" | "build";
  messageId: string;
  /** Full final text, so clients can reconcile. */
  text: string;
  /** Model that produced the reply (for debugging/metering). */
  model: string;
}

/** High-level agent state, shown as the friendly status line. */
export interface AgentStatusEvent {
  type: "agent.status";
  status:
    | "idle"
    | "planning"
    | "writing"
    | "installing"
    | "checking"
    | "fixing"
    | "done"
    | "failed";
  /** Human-friendly message, e.g. "Creating your home screen..." */
  message: string;
}

/** Granular build/agent activity for the build log pane. */
export interface BuildEventEvent {
  type: "build.event";
  level: "info" | "warn" | "error";
  source: "agent" | "metro" | "system";
  text: string;
  timestamp: string;
}

/** Agent touched a file (drives the "watch it build" effect). */
export interface FileOpEvent {
  type: "file.op";
  op: "write" | "delete";
  path: string;
}

export interface PreviewStatusEvent {
  type: "preview.status";
  status: "starting" | "ready" | "stopped" | "error";
  /** URL for the phone-framed web preview iframe. */
  webUrl?: string;
  /** exp:// URL encoded into the QR code for Expo Go. */
  expUrl?: string;
}

export interface SpecUpdatedEvent {
  type: "spec.updated";
  version: number;
  spec: AppSpec;
}

export interface ProjectStatusEvent {
  type: "project.status";
  status: ProjectStatus;
}

export interface CheckpointCreatedEvent {
  type: "checkpoint.created";
  checkpointId: string;
  label: string;
}

/** Runtime tap-to-edit override instruction sent to the preview frame. */
export interface TapEditApplyEvent {
  type: "tap_edit.apply";
  testID: string;
  patch: {
    text?: string;
    color?: string;
    backgroundColor?: string;
    fontSize?: number;
    fontWeight?: string;
    fontFamily?: string;
  };
}

export interface ErrorEvent {
  type: "error";
  code: string;
  message: string;
}

export interface PongEvent {
  type: "pong";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg === "object" && msg !== null && typeof msg.type === "string") {
      return msg as ClientMessage;
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

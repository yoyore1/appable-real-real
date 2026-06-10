/**
 * The App Spec is the artifact produced by the interview pipeline and
 * consumed by the build agent and the dashboard. Versioned in Postgres.
 */

export interface AppSpec {
  name: string;
  tagline: string;
  description: string;
  /** e.g. "productivity", "fitness", "social" */
  category: string;
  /** Visual direction the agent should follow. */
  vibe: {
    tone: string;
    primaryColor: string;
    style: string;
  };
  screens: ScreenSpec[];
  dataModel: EntitySpec[];
  features: string[];
  /** Things the user explicitly said they do NOT want. */
  nonGoals: string[];
  /** Auto-generated legal/support documents (filled in by the platform). */
  legal?: LegalDocs;
}

export interface LegalDocs {
  privacy: string;
  terms: string;
  support: string;
}

export interface ScreenSpec {
  name: string;
  purpose: string;
  /** Key UI elements / interactions on this screen. */
  elements: string[];
}

export interface EntitySpec {
  name: string;
  fields: { name: string; type: string; description?: string }[];
}

export type ProjectStatus =
  | "new"
  | "interviewing"
  | "spec_ready"
  | "building"
  | "running"
  | "sleeping"
  | "error";

export type ConversationKind = "interview" | "brainstorm" | "build";

export type MessageRole = "user" | "assistant" | "system" | "tool";

import type { PendingRequest, Workspace } from "../shared/types";

export type ThreadStatus = { type: "notLoaded" | "idle" | "systemError" | "active" };

export type ThreadItem = Record<string, unknown> & { type: string; id?: string };

export type Turn = {
  id: string;
  items: ThreadItem[];
  preferences?: Preferences;
  status: string;
  error: unknown;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
};

export type Thread = {
  id: string;
  sessionId: string;
  parentThreadId: string | null;
  preview: string;
  name: string | null;
  cwd: string;
  source: unknown;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  archived?: boolean;
  turns: Turn[];
};

export type Model = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
};

export type Preferences = { model: string | null; effort: string | null; fullAccess: boolean };

export type HistoryPage = {
  turns: Turn[];
  nextCursor: string | null;
};

export type Snapshot = {
  connected: boolean;
  threads: Thread[];
  workspaces: Workspace[];
  models: Model[];
  unreadThreadIds: string[];
  pendingRequests: PendingRequest[];
};

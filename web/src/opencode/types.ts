import type { Workspace } from "../shared/types";

export type ThreadStatus = { type: "idle" | "active" | "notLoaded" };

export type Thread = {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  archived?: boolean;
  agent: string | null;
  model: string | null;
};

export type MessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  modelID?: string;
  providerID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  mode?: string;
  cost?: number;
  tokens?: Record<string, unknown>;
  error?: unknown;
  parentID?: string;
};

export type Part = Record<string, unknown> & { id?: string; type: string; messageID?: string; sessionID?: string };

export type Message = { info: MessageInfo; parts: Part[] };

export type Model = {
  id: string;
  providerID: string;
  modelID: string;
  displayName: string;
  isDefault: boolean;
};

export type SessionState = { model: string | null; agent: string | null; fullAccess: boolean };

export type PendingPermission = {
  key: string;
  requestId: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type Snapshot = {
  connected: boolean;
  threads: Thread[];
  workspaces: Workspace[];
  models: Model[];
  unreadThreadIds: string[];
  pendingRequests: PendingPermission[];
};

export type BusEvent = { type?: string; properties?: Record<string, unknown> };

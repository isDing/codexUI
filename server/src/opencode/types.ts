export type OcSession = {
  id: string;
  projectID?: string;
  directory: string;
  path?: string;
  title: string;
  agent?: string;
  model?: { id?: string; providerID?: string };
  cost?: number;
  tokens?: unknown;
  time: { created: number; updated: number };
  version?: string;
};

export type OcThreadStatus = { type: "idle" | "active" | "notLoaded" };

export type OcThread = {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: OcThreadStatus;
  archived?: boolean;
  agent: string | null;
  model: string | null;
};

export type OcMessageInfo = {
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

export type OcPart = Record<string, unknown> & { id?: string; type: string; messageID?: string; sessionID?: string };

export type OcMessage = { info: OcMessageInfo; parts: OcPart[] };

export type OcModel = {
  id: string;
  providerID: string;
  modelID: string;
  displayName: string;
  isDefault: boolean;
};

export type OcPendingRequest = {
  key: string;
  requestId: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type OcEvent = { type?: string; properties?: Record<string, unknown> };

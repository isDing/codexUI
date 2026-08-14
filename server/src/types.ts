export type JsonObject = Record<string, unknown>;

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags?: string[] };

export type CodexThread = {
  id: string;
  sessionId: string;
  parentThreadId: string | null;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status: ThreadStatus;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: unknown;
  name: string | null;
  turns: CodexTurn[];
  archived?: boolean;
};

export type CodexTurn = {
  id: string;
  items: ThreadItem[];
  status: string;
  error: unknown;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
};

export type ThreadItem = Record<string, unknown> & { type: string; id?: string };

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
};

export type ThreadPreferences = {
  model: string | null;
  effort: string | null;
  fullAccess: boolean;
};

export type Workspace = {
  path: string;
  name: string;
  threadCount: number;
  activeCount: number;
  latestAt: number;
};

export type SessionInfo = {
  id: string;
  csrfToken: string;
  username: string;
  lastActivityAt: number;
  expiresAt: number;
};

export type ApprovalRequest = {
  requestId: number | string;
  method: string;
  params: JsonObject;
  createdAt: number;
};

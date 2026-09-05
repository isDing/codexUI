export type Workspace = {
  path: string;
  name: string;
  threadCount: number;
  activeCount: number;
  latestAt: number;
};

export type AuthState = {
  authenticated: boolean;
  username?: string;
  csrfToken?: string;
  expiresAt?: number;
};

export type PendingRequest = {
  key: string;
  requestId: string | number;
  method: string;
  params: Record<string, unknown>;
  createdAt: number;
};

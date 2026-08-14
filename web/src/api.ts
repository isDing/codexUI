import type { AuthState, Preferences, Snapshot, Thread } from "./types";

export class ApiClient {
  private csrfToken = "";

  constructor(private readonly onUnauthorized: () => void) {}

  setCsrfToken(value: string | undefined): void {
    this.csrfToken = value ?? "";
  }

  authSession(): Promise<AuthState> {
    return this.request("/api/auth/session");
  }

  login(username: string, password: string): Promise<AuthState> {
    return this.request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  }

  logout(): Promise<AuthState> {
    return this.request("/api/auth/logout", this.writeOptions());
  }

  activity(): Promise<{ expiresAt: number }> {
    return this.request("/api/auth/activity", this.writeOptions());
  }

  bootstrap(): Promise<Snapshot> {
    return this.request("/api/bootstrap");
  }

  readThread(threadId: string): Promise<{ thread: Thread; preferences: Preferences }> {
    return this.request(`/api/threads/${encodeURIComponent(threadId)}`);
  }

  markRead(threadId: string): Promise<{ unreadThreadIds: string[] }> {
    return this.request(`/api/threads/${encodeURIComponent(threadId)}/read`, this.writeOptions());
  }

  createThread(value: { cwd: string } & Preferences): Promise<{ thread: Thread; preferences: Preferences }> {
    return this.request("/api/threads", this.writeOptions(value));
  }

  startTurn(threadId: string, value: { text: string } & Preferences): Promise<unknown> {
    return this.request(`/api/threads/${encodeURIComponent(threadId)}/turns`, this.writeOptions(value));
  }

  respondToRequest(key: string, value: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/requests/${encodeURIComponent(key)}/respond`, this.writeOptions(value));
  }

  private writeOptions(body?: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "x-csrf-token": this.csrfToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
    });
    if (response.status === 401) this.onUnauthorized();
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`);
    return body as T;
  }
}

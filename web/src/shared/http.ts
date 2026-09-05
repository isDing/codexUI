import type { AuthState } from "./types";

export type RequestOptions = { signal?: AbortSignal };

export class HttpBase {
  private csrfToken = "";

  constructor(protected readonly onUnauthorized: () => void) {}

  setCsrfToken(value: string | undefined): void {
    this.csrfToken = value ?? "";
  }

  protected get csrf(): string {
    return this.csrfToken;
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

  meta(): Promise<{ backends: string[] }> {
    return this.request("/api/meta");
  }

  protected writeOptions(body?: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "x-csrf-token": this.csrfToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }

  protected async request<T>(url: string, options: RequestInit = {}): Promise<T> {
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

import { HttpBase, type RequestOptions } from "../shared/http";
import type { Message, SessionState, Snapshot, Thread } from "./types";

export class OpencodeApiClient extends HttpBase {
  bootstrap(): Promise<Snapshot> {
    return this.request("/api/opencode/bootstrap");
  }

  addWorkspace(path: string): Promise<{ path: string; workspaces: Snapshot["workspaces"] }> {
    return this.request("/api/opencode/workspaces", this.writeOptions({ path }));
  }

  readThread(threadId: string, options: RequestOptions = {}): Promise<{ thread: Thread; state: SessionState; messages: Message[] }> {
    return this.request(`/api/opencode/threads/${encodeURIComponent(threadId)}`, { signal: options.signal });
  }

  markRead(threadId: string, options: RequestOptions = {}): Promise<{ unreadThreadIds: string[] }> {
    return this.request(`/api/opencode/threads/${encodeURIComponent(threadId)}/read`, { ...this.writeOptions(), signal: options.signal });
  }

  cancelTurn(threadId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/opencode/threads/${encodeURIComponent(threadId)}/cancel`, this.writeOptions({}));
  }

  deleteThread(threadId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/opencode/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      headers: { "x-csrf-token": this.csrf },
    });
  }

  runCommand(threadId: string, command: string, args?: string): Promise<{ ok: boolean }> {
    return this.request(
      `/api/opencode/threads/${encodeURIComponent(threadId)}/command`,
      this.writeOptions({ command, args }),
    );
  }

  createThread(value: { cwd: string; model?: string | null; agent?: string | null; fullAccess: boolean }): Promise<{ thread: Thread; state: SessionState }> {
    return this.request("/api/opencode/threads", this.writeOptions(value));
  }

  startTurn(threadId: string, value: { text: string; model: string | null; agent: string | null; fullAccess: boolean }): Promise<{ ok: boolean }> {
    return this.request(`/api/opencode/threads/${encodeURIComponent(threadId)}/turns`, this.writeOptions(value));
  }

  retryTurn(threadId: string, value: { text: string; model: string | null; agent: string | null; fullAccess: boolean }): Promise<{ ok: boolean; reverted?: boolean }> {
    return this.request(`/api/opencode/threads/${encodeURIComponent(threadId)}/retry`, this.writeOptions(value));
  }

  respondToRequest(key: string, value: { reply: "once" | "always" | "reject" }): Promise<{ pendingRequests: unknown[] }> {
    return this.request(`/api/opencode/requests/${encodeURIComponent(key)}/respond`, this.writeOptions(value));
  }
}

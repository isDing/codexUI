import { HttpBase, type RequestOptions } from "../shared/http";
import type { HistoryPage, Preferences, Snapshot, Thread, Turn } from "./types";

export class CodexApiClient extends HttpBase {
  bootstrap(): Promise<Snapshot> {
    return this.request("/api/codex/bootstrap");
  }

  addWorkspace(path: string): Promise<{ path: string; workspaces: Snapshot["workspaces"] }> {
    return this.request("/api/codex/workspaces", this.writeOptions({ path }));
  }

  readThread(threadId: string, options: RequestOptions = {}): Promise<{ thread: Thread; preferences: Preferences; nextCursor: string | null }> {
    return this.request(`/api/codex/threads/${encodeURIComponent(threadId)}`, { signal: options.signal });
  }

  readThreadHistory(threadId: string, cursor: string, options: RequestOptions = {}): Promise<HistoryPage> {
    return this.request(`/api/codex/threads/${encodeURIComponent(threadId)}/history?cursor=${encodeURIComponent(cursor)}`, { signal: options.signal });
  }

  markRead(threadId: string, options: RequestOptions = {}): Promise<{ unreadThreadIds: string[] }> {
    return this.request(`/api/codex/threads/${encodeURIComponent(threadId)}/read`, { ...this.writeOptions(), signal: options.signal });
  }

  cancelTurn(threadId: string, turnId?: string): Promise<{ ok: boolean }> {
    return this.request(
      `/api/codex/threads/${encodeURIComponent(threadId)}/cancel`,
      this.writeOptions(turnId ? { turnId } : {}),
    );
  }

  deleteThread(threadId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/codex/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      headers: { "x-csrf-token": this.csrf },
    });
  }

  runCommand(threadId: string, command: string, args?: string): Promise<{ ok: boolean }> {
    return this.request(
      `/api/codex/threads/${encodeURIComponent(threadId)}/command`,
      this.writeOptions({ command, args }),
    );
  }

  createThread(value: { cwd: string } & Preferences): Promise<{ thread: Thread; preferences: Preferences }> {
    return this.request("/api/codex/threads", this.writeOptions(value));
  }

  startTurn(threadId: string, value: { text: string } & Preferences): Promise<{ turn?: Turn }> {
    return this.request(`/api/codex/threads/${encodeURIComponent(threadId)}/turns`, this.writeOptions(value));
  }

  retryTurn(threadId: string, value: { text: string } & Preferences): Promise<{ turn?: Turn }> {
    return this.request(`/api/codex/threads/${encodeURIComponent(threadId)}/retry`, this.writeOptions(value));
  }

  respondToRequest(key: string, value: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/codex/requests/${encodeURIComponent(key)}/respond`, this.writeOptions(value));
  }
}

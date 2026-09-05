import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../database.js";
import type { OcState } from "../types.js";
import { OpencodeClient } from "./client.js";
import type {
  OcEvent,
  OcMessage,
  OcModel,
  OcPendingRequest,
  OcSession,
  OcThread,
} from "./types.js";

const requestKey = (id: string): string => Buffer.from(`oc:${id}`).toString("base64url");

const PENDING_THREAD_TTL_MS = 5 * 60_000;

const FORWARDED_EVENTS = new Set([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.removed",
  "session.status",
  "session.idle",
  "session.error",
  "permission.asked",
  "permission.replied",
]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const modelIdOf = (session: OcSession): string | null => {
  const providerID = session.model?.providerID;
  const modelID = session.model?.id;
  return providerID && modelID ? `${providerID}/${modelID}` : null;
};

const threadFromSession = (session: OcSession, previous?: OcThread): OcThread => ({
  id: session.id,
  title: session.title ?? "",
  preview: session.title ?? "",
  cwd: session.directory,
  createdAt: Math.floor((session.time?.created ?? Date.now()) / 1000),
  updatedAt: Math.floor((session.time?.updated ?? session.time?.created ?? Date.now()) / 1000),
  status: previous?.status ?? { type: "idle" },
  archived: previous?.archived ?? false,
  agent: session.agent ?? previous?.agent ?? null,
  model: modelIdOf(session) ?? previous?.model ?? null,
});

type ProviderModels = {
  providers?: Array<{ id?: string; name?: string; models?: Record<string, { id?: string; title?: string }> }>;
  default?: Record<string, string>;
};

export class OpencodeService extends EventEmitter {
  private readonly client: OpencodeClient;
  private readonly threads = new Map<string, OcThread>();
  private readonly pendingSince = new Map<string, number>();
  private readonly approvals = new Map<string, OcPendingRequest>();
  private readonly turnStartAt = new Map<string, number>();
  private readonly viewers = new Map<string, string>();
  private models: OcModel[] = [];
  private connected = false;
  private polling = false;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
  ) {
    super();
    this.client = new OpencodeClient(config);
    this.client.on("status", (status: { connected: boolean; message: string }) => {
      this.connected = status.connected;
      this.broadcast("connection", status);
      if (status.connected) {
        void this.refreshModels().catch((error) => console.warn("Failed to refresh opencode models:", error));
        void this.refreshThreads().catch((error) => console.warn("Failed to refresh opencode threads:", error));
      }
    });
    this.client.on("diagnostic", (line: string) => console.warn(`[opencode] ${line}`));
    this.client.on("event", (event: OcEvent) => this.onEvent(event));
  }

  get ocConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    const operation = (async () => {
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => void this.refreshThreads().catch(() => undefined), this.config.pollIntervalMs);
      }
      try {
        await this.client.start();
        const initialLoads = await Promise.allSettled([this.refreshThreads(), this.refreshModels()]);
        for (const result of initialLoads) {
          if (result.status === "rejected") console.warn("Initial opencode state refresh failed:", result.reason);
        }
        this.started = true;
      } catch (error) {
        throw error;
      }
    })();
    this.startPromise = operation;
    try {
      await operation;
    } finally {
      if (this.startPromise === operation) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.startPromise = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.client.stop();
  }

  async snapshot() {
    if (this.threads.size === 0 && this.connected) await this.refreshThreads();
    return {
      connected: this.connected,
      threads: this.sortedThreads(),
      workspaces: await this.listWorkspaces(),
      models: this.models,
      unreadThreadIds: this.db.ocUnreadThreadIds(),
      pendingRequests: this.publicApprovals(),
    };
  }

  async readThread(threadId: string) {
    const encoded = encodeURIComponent(threadId);
    const [session, messages] = await Promise.all([
      this.client.request<OcSession>("GET", `/session/${encoded}`),
      this.client.request<OcMessage[]>("GET", `/session/${encoded}/message`),
    ]);
    const previous = this.threads.get(threadId);
    const thread = threadFromSession(session, previous);
    this.threads.set(thread.id, { ...thread, archived: previous?.archived ?? false });
    return { thread, state: this.db.getOcState(threadId), messages: Array.isArray(messages) ? messages : [] };
  }

  async createThread(input: { cwd: string; model?: string | null; agent?: string | null; fullAccess: boolean }) {
    const cwd = await this.validateWorkspace(input.cwd);
    const session = await this.client.request<OcSession>("POST", "/session", { query: { directory: cwd }, body: {} });
    const thread = threadFromSession(session);
    const state: OcState = {
      model: input.model ?? modelIdOf(session) ?? null,
      agent: input.agent ?? session.agent ?? null,
      fullAccess: input.fullAccess,
    };
    this.db.setOcState(thread.id, state);
    this.threads.set(thread.id, thread);
    this.pendingSince.set(thread.id, Date.now());
    this.broadcast("threads.changed", { thread });
    return { thread, state };
  }

  async startTurn(threadId: string, input: { text: string; model: string | null; agent: string | null; fullAccess: boolean }) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("会话不存在");
    if (thread.status.type === "active") throw new Error("该会话已有任务正在执行");
    const stored = this.db.getOcState(threadId);
    const model = input.model ?? stored.model;
    const agent = input.agent ?? stored.agent;
    this.db.setOcState(threadId, { model, agent, fullAccess: input.fullAccess });
    this.db.markOcRead(threadId);
    const body: Record<string, unknown> = { parts: [{ type: "text", text: input.text }] };
    const parsed = model ? this.parseModel(model) : null;
    if (parsed) body.model = parsed;
    if (agent) body.agent = agent;
    await this.client.request("POST", `/session/${encodeURIComponent(threadId)}/prompt_async`, { body });
    this.pendingSince.delete(threadId);
    this.turnStartAt.set(threadId, Date.now());
    thread.status = { type: "active" };
    this.broadcast("threads.changed", { threads: this.sortedThreads() });
    return { ok: true };
  }

  async retryTurn(threadId: string, input: { text: string; model: string | null; agent: string | null; fullAccess: boolean }) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("会话不存在");
    const messages = await this.client.request<OcMessage[]>(
      "GET",
      `/session/${encodeURIComponent(threadId)}/message`,
    );
    const lastUser = Array.isArray(messages) ? [...messages].reverse().find((entry) => entry.info?.role === "user") : undefined;
    if (lastUser) {
      await this.client
        .request("POST", `/session/${encodeURIComponent(threadId)}/revert`, { body: { messageID: lastUser.info.id } })
        .catch(() => undefined);
    }
    return { ...(await this.startTurn(threadId, input)), reverted: Boolean(lastUser) };
  }

  async cancelTurn(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("会话不存在");
    await this.client.request("POST", `/session/${encodeURIComponent(threadId)}/abort`);
    thread.status = { type: "idle" };
    this.clearApprovalsFor(threadId);
    this.broadcast("threads.changed", { threads: this.sortedThreads() });
    return { ok: true };
  }

  async deleteThread(threadId: string): Promise<void> {
    const known = this.threads.get(threadId);
    if (!known) throw new Error("会话不存在");
    await this.client.request("POST", `/session/${encodeURIComponent(threadId)}/abort`).catch(() => undefined);
    await this.client.request("DELETE", `/session/${encodeURIComponent(threadId)}`);
    this.forgetThread(threadId);
    this.db.deleteOcThreadState(threadId);
    this.broadcast("threads.changed", { threads: this.sortedThreads() });
    this.broadcast("unread.changed", { unreadThreadIds: this.db.ocUnreadThreadIds() });
  }

  async runCommand(threadId: string, command: string, args: string | undefined) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("会话不存在");
    const encoded = encodeURIComponent(threadId);
    switch (command) {
      case "rename": {
        if (!args?.trim()) throw new Error("请提供新名称：/rename <名称>");
        const title = args.trim();
        await this.client.request("PATCH", `/session/${encoded}`, { body: { title } });
        thread.title = title;
        thread.preview = title;
        break;
      }
      case "compact": {
        const parsed = this.parseModel(thread.model ?? this.db.getOcState(threadId).model ?? "") ?? this.defaultModel();
        if (!parsed) throw new Error("未找到可用模型，无法整理上下文");
        await this.client.request("POST", `/session/${encoded}/summarize`, { body: parsed });
        break;
      }
      default:
        throw new Error("opencode 不支持该命令");
    }
    this.broadcast("threads.changed", { threads: this.sortedThreads() });
    return { ok: true };
  }

  respondToRequest(key: string, body: { reply?: unknown }): void {
    const pending = this.approvals.get(key);
    if (!pending) throw new Error("该请求已处理或不存在");
    const reply = body.reply === "always" || body.reply === "reject" ? body.reply : "once";
    const thread = this.threads.get(pending.sessionID);
    void this.client
      .request("POST", `/permission/${encodeURIComponent(pending.requestId)}/reply`, {
        query: thread ? { directory: thread.cwd } : {},
        body: { reply },
      })
      .catch((error) => console.warn("Failed to reply opencode permission:", error));
    this.approvals.delete(key);
    this.broadcast("requests.changed", { pendingRequests: this.publicApprovals() });
  }

  markRead(threadId: string): void {
    this.db.markOcRead(threadId);
    this.broadcast("unread.changed", { unreadThreadIds: this.db.ocUnreadThreadIds() });
  }

  setViewer(clientId: string, threadId: string | null): void {
    if (threadId) this.viewers.set(clientId, threadId);
    else this.viewers.delete(clientId);
  }

  removeViewer(clientId: string): void {
    this.viewers.delete(clientId);
  }

  publicApprovals(): OcPendingRequest[] {
    return [...this.approvals.values()];
  }

  async addWorkspace(candidate: string) {
    const workspacePath = await this.validateWorkspace(candidate);
    this.db.addWorkspacePath(workspacePath);
    const workspaces = await this.listWorkspaces();
    this.broadcast("workspaces.changed", { workspaces });
    return { path: workspacePath, workspaces };
  }

  private parseModel(value: string): { providerID: string; modelID: string } | null {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) return null;
    return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
  }

  private defaultModel(): { providerID: string; modelID: string } | null {
    const model = this.models.find((entry) => entry.isDefault) ?? this.models[0];
    return model ? { providerID: model.providerID, modelID: model.modelID } : null;
  }

  private clearApprovalsFor(threadId: string): void {
    let changed = false;
    for (const [key, request] of this.approvals) {
      if (request.sessionID === threadId) {
        this.approvals.delete(key);
        changed = true;
      }
    }
    if (changed) this.broadcast("requests.changed", { pendingRequests: this.publicApprovals() });
  }

  private forgetThread(threadId: string): void {
    this.threads.delete(threadId);
    this.pendingSince.delete(threadId);
    this.turnStartAt.delete(threadId);
    this.clearApprovalsFor(threadId);
  }

  private async refreshModels(): Promise<void> {
    const result = await this.client.request<ProviderModels>("GET", "/config/providers");
    const models: OcModel[] = [];
    for (const provider of result?.providers ?? []) {
      if (!provider?.id) continue;
      const defaultModel = result.default?.[provider.id];
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        models.push({
          id: `${provider.id}/${modelID}`,
          providerID: provider.id,
          modelID,
          displayName: model?.title ?? modelID,
          isDefault: defaultModel === modelID,
        });
      }
    }
    this.models = models;
  }

  private async refreshThreads(): Promise<void> {
    if (this.polling || !this.connected) return;
    this.polling = true;
    try {
      const directories = await this.collectWorkspacePaths();
      for (const directory of directories) this.client.subscribe(directory);
      const next = new Map<string, OcThread>();
      const results = await Promise.allSettled(
        [...directories].map((directory) =>
          this.client.request<OcSession[]>("GET", "/session", { query: { directory }, timeoutMs: 15_000 }),
        ),
      );
      for (const result of results) {
        if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
        for (const session of result.value) {
          if (!session?.id) continue;
          const previous = this.threads.get(session.id);
          next.set(session.id, threadFromSession(session, previous));
        }
      }
      const busy = new Set<string>();
      const statuses = await Promise.allSettled(
        [...directories].map((directory) =>
          this.client.request<Record<string, { type?: string }>>("GET", "/session/status", { query: { directory }, timeoutMs: 15_000 }),
        ),
      );
      for (const result of statuses) {
        if (result.status !== "fulfilled" || !isRecord(result.value)) continue;
        for (const [sessionId, status] of Object.entries(result.value)) {
          if (isRecord(status) && status.type === "busy") busy.add(sessionId);
        }
      }
      // /session/status 只返回运行中的会话：不在 busy 集合中的会话一律视为空闲，
      // 但刚发起的 turn 给 15 秒宽限，避免 opencode 尚未标记 busy 时界面回跳
      const now = Date.now();
      for (const thread of next.values()) {
        if (busy.has(thread.id)) thread.status = { type: "active" };
        else if (thread.status.type === "active" && now - (this.turnStartAt.get(thread.id) ?? 0) < 15_000) continue;
        else thread.status = { type: "idle" };
      }

      for (const [threadId, thread] of this.threads) {
        if (next.has(threadId)) continue;
        const since = this.pendingSince.get(threadId);
        if (since !== undefined && Date.now() - since < PENDING_THREAD_TTL_MS) next.set(threadId, thread);
        else if (thread.status.type === "active") next.set(threadId, thread);
      }
      for (const threadId of [...this.pendingSince.keys()]) {
        if (!next.has(threadId)) this.pendingSince.delete(threadId);
      }

      let changed = next.size !== this.threads.size;
      for (const [id, thread] of next) {
        const before = this.threads.get(id);
        if (
          !before ||
          before.updatedAt !== thread.updatedAt ||
          before.status.type !== thread.status.type ||
          before.title !== thread.title
        ) changed = true;
        if (before?.status.type === "active" && thread.status.type !== "active") this.recordCompletion(id);
      }
      this.threads.clear();
      for (const [id, thread] of next) this.threads.set(id, thread);
      if (changed) this.broadcast("threads.changed", { threads: this.sortedThreads() });
    } catch (error) {
      console.warn("Failed to refresh opencode threads:", error);
    } finally {
      this.polling = false;
    }
  }

  private onEvent(event: OcEvent): void {
    const properties = isRecord(event.properties) ? event.properties : {};
    const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        const info = properties.info as OcSession | undefined;
        if (info?.id && info.time) {
          const thread = threadFromSession(info, this.threads.get(info.id));
          this.threads.set(thread.id, thread);
          this.pendingSince.delete(thread.id);
          this.broadcast("threads.changed", { thread });
        }
        break;
      }
      case "session.deleted": {
        if (sessionID && this.threads.delete(sessionID)) {
          this.pendingSince.delete(sessionID);
          this.clearApprovalsFor(sessionID);
          this.db.deleteOcThreadState(sessionID);
          this.broadcast("threads.changed", { threads: this.sortedThreads() });
          this.broadcast("unread.changed", { unreadThreadIds: this.db.ocUnreadThreadIds() });
        }
        break;
      }
      case "session.status": {
        if (!sessionID) break;
        const status = properties.status;
        const active = isRecord(status) && status.type === "busy";
        const thread = this.threads.get(sessionID);
        if (thread) thread.status = { type: active ? "active" : "idle" };
        if (!active) {
          this.turnStartAt.delete(sessionID);
          this.recordCompletion(sessionID);
        }
        this.broadcast("threads.changed", { threads: this.sortedThreads() });
        break;
      }
      case "session.idle":
      case "session.error": {
        if (!sessionID) break;
        const thread = this.threads.get(sessionID);
        if (!thread || thread.status.type !== "active") break;
        thread.status = { type: "idle" };
        this.turnStartAt.delete(sessionID);
        this.recordCompletion(sessionID);
        this.broadcast("threads.changed", { threads: this.sortedThreads() });
        break;
      }
      case "permission.asked": {
        const requestId = typeof properties.id === "string" ? properties.id : null;
        if (!requestId || !sessionID) break;
        if (this.db.getOcState(sessionID).fullAccess) {
          const thread = this.threads.get(sessionID);
          void this.client
            .request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, {
              query: thread ? { directory: thread.cwd } : {},
              body: { reply: "always" },
            })
            .catch((error) => console.warn("Failed to auto-approve opencode permission:", error));
          break;
        }
        const key = requestKey(requestId);
        this.approvals.set(key, {
          key,
          requestId,
          sessionID,
          permission: typeof properties.permission === "string" ? properties.permission : "unknown",
          patterns: Array.isArray(properties.patterns) ? properties.patterns.map(String) : [],
          metadata: isRecord(properties.metadata) ? properties.metadata : {},
          createdAt: Date.now(),
        });
        this.broadcast("requests.changed", { pendingRequests: this.publicApprovals() });
        break;
      }
      case "permission.replied": {
        const requestId =
          typeof properties.requestID === "string" ? properties.requestID : typeof properties.id === "string" ? properties.id : null;
        if (requestId) {
          const key = requestKey(requestId);
          if (this.approvals.delete(key)) this.broadcast("requests.changed", { pendingRequests: this.publicApprovals() });
        }
        break;
      }
      default:
        break;
    }
    if (FORWARDED_EVENTS.has(event.type ?? "")) this.broadcast("opencode.event", event);
  }

  private recordCompletion(threadId: string): void {
    const beingViewed = [...this.viewers.values()].some((value) => value === threadId);
    if (!beingViewed) this.db.markOcUnread(threadId);
    this.broadcast("unread.changed", { unreadThreadIds: this.db.ocUnreadThreadIds() });
  }

  private sortedThreads(): OcThread[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async collectWorkspacePaths(): Promise<Set<string>> {
    const paths = new Set<string>();
    for (const thread of this.threads.values()) paths.add(path.resolve(thread.cwd));
    for (const workspacePath of this.db.workspacePaths()) paths.add(path.resolve(workspacePath));
    for (const root of this.config.workspaceRoots) {
      paths.add(root);
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) paths.add(path.join(root, entry.name));
        }
      } catch (error) {
        console.warn(`Cannot scan workspace root ${root}:`, error);
      }
    }
    return paths;
  }

  private async listWorkspaces() {
    const paths = await this.collectWorkspacePaths();
    return [...paths]
      .map((workspacePath) => {
        const members = [...this.threads.values()].filter((thread) => path.resolve(thread.cwd) === workspacePath);
        return {
          path: workspacePath,
          name: path.basename(workspacePath) || workspacePath,
          threadCount: members.length,
          activeCount: members.filter((thread) => thread.status.type === "active").length,
          latestAt: Math.max(0, ...members.map((thread) => thread.updatedAt)),
        };
      })
      .sort((a, b) => b.latestAt - a.latestAt || a.name.localeCompare(b.name));
  }

  private async validateWorkspace(candidate: string): Promise<string> {
    const resolved = path.resolve(candidate);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("工作区目录不存在或不是目录");
    const realCandidate = await fs.realpath(resolved);
    const realRoots = await Promise.all(
      this.config.workspaceRoots.map((root) => fs.realpath(root).catch(() => path.resolve(root))),
    );
    const insideRoot = realRoots.some(
      (root) => realCandidate === root || realCandidate.startsWith(`${root}${path.sep}`),
    );
    if (!insideRoot) throw new Error("工作区不在允许的目录中");
    return resolved;
  }

  private broadcast(type: string, payload: unknown): void {
    this.emit("event", { type, payload, at: Date.now() });
  }
}

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { CodexAppServer } from "./codex-app-server.js";
import type { AppDatabase } from "./database.js";
import type {
  ApprovalRequest,
  CodexModel,
  CodexThread,
  JsonObject,
  RpcMessage,
  ThreadPreferences,
  Workspace,
} from "./types.js";

const SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];
const INITIAL_HISTORY_PAGE_SIZE = 2;
const HISTORY_PAGE_SIZE = 4;

const rpcResult = <T>(value: unknown): T => value as T;
const requestKey = (id: number | string): string => Buffer.from(String(id)).toString("base64url");

type RuntimeSettings = JsonObject & {
  model?: unknown;
  reasoningEffort?: unknown;
  effort?: unknown;
  approvalPolicy?: unknown;
  approval_policy?: unknown;
  sandbox?: unknown;
  sandboxPolicy?: unknown;
  sandbox_mode?: unknown;
  activePermissionProfile?: unknown;
  active_permission_profile?: unknown;
  permission_profile?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const stringValue = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const permissionProfileId = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  return stringValue(value.id);
};

const sandboxType = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  return isRecord(value) ? stringValue(value.type) : null;
};

export const preferencesFromRuntimeSettings = (
  settings: RuntimeSettings,
  fallback: ThreadPreferences = { model: null, effort: null, fullAccess: false },
): ThreadPreferences => {
  const profileId = permissionProfileId(settings.activePermissionProfile ?? settings.active_permission_profile);
  const approvalPolicy = settings.approvalPolicy ?? settings.approval_policy;
  const sandbox = settings.sandbox ?? settings.sandboxPolicy ?? settings.sandbox_mode;
  const profileDisabled = isRecord(settings.permission_profile) && settings.permission_profile.type === "disabled";
  const fullAccess =
    profileId === ":danger-full-access" ||
    profileDisabled ||
    (approvalPolicy === "never" && sandboxType(sandbox) === "dangerFullAccess") ||
    (approvalPolicy === "never" && sandboxType(sandbox) === "danger-full-access");
  return {
    model: stringValue(settings.model) ?? fallback.model,
    effort: stringValue(settings.reasoningEffort ?? settings.effort) ?? fallback.effort,
    fullAccess: fullAccess || (approvalPolicy === undefined && sandbox === undefined ? fallback.fullAccess : false),
  };
};

export const preferencesFromPersistedSettings = (
  settings: JsonObject,
  fallback: ThreadPreferences = { model: null, effort: null, fullAccess: false },
): ThreadPreferences => {
  const profileId = permissionProfileId(settings.active_permission_profile ?? settings.activePermissionProfile);
  const profileDisabled = isRecord(settings.permission_profile) && settings.permission_profile.type === "disabled";
  const approvalPolicy = settings.approval_policy ?? settings.approvalPolicy;
  const sandbox = settings.sandbox_mode ?? settings.sandbox ?? settings.sandboxPolicy;
  const fullAccess =
    profileId === ":danger-full-access" ||
    profileDisabled ||
    (approvalPolicy === "never" && sandboxType(sandbox) === "danger-full-access") ||
    (approvalPolicy === "never" && sandboxType(sandbox) === "dangerFullAccess");
  return {
    model: stringValue(settings.model) ?? fallback.model,
    effort: stringValue(settings.reasoning_effort ?? settings.reasoningEffort ?? settings.effort) ?? fallback.effort,
    fullAccess: fullAccess || (approvalPolicy === undefined && sandbox === undefined ? fallback.fullAccess : false),
  };
};

const persistedSettingsFromLine = (line: string): JsonObject | null => {
  try {
    const event = JSON.parse(line) as { payload?: unknown };
    const payload = event.payload;
    return isRecord(payload) && payload.type === "thread_settings_applied" && isRecord(payload.thread_settings)
      ? payload.thread_settings
      : null;
  } catch {
    return null;
  }
};

type PersistedSettingsResult = ThreadPreferences | null;

const PENDING_THREAD_TTL_MS = 5 * 60_000;
const MAX_PERSISTED_SETTINGS_SCAN_BYTES = 2 * 1024 * 1024;
const READ_CACHE_TTL_MS = 10_000;
const PREF_SCAN_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;

type ReadThreadResult = {
  thread: CodexThread;
  preferences: ThreadPreferences;
  nextCursor: string | null;
};

export class CodexService extends EventEmitter {
  private readonly rpc: CodexAppServer;
  private readonly threads = new Map<string, CodexThread>();
  private readonly pendingThreads = new Map<string, CodexThread>();
  private readonly pendingSince = new Map<string, number>();
  private readonly readCache = new Map<string, { at: number; updatedAt: number; value: ReadThreadResult }>();
  private readonly prefScanCache = new Map<string, { at: number; threadUpdatedAt: number; prefs: ThreadPreferences | null }>();
  private models: CodexModel[] = [];
  private approvals = new Map<string, ApprovalRequest>();
  private viewers = new Map<string, string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private connected = false;

  private cachePrune(map: Map<string, unknown>): void {
    while (map.size > MAX_CACHE_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest as string);
    }
  }

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
  ) {
    super();
    this.rpc = new CodexAppServer(config);
    this.rpc.on("notification", (message: RpcMessage) => this.onNotification(message));
    this.rpc.on("serverRequest", (message: RpcMessage) => this.onServerRequest(message));
    this.rpc.on("status", (status: { connected: boolean; message: string }) => {
      this.connected = status.connected;
      this.broadcast("connection", status);
      // 断线重连后模型列表可能仍为空，主动补拉一次
      if (status.connected) void this.refreshModels().catch((error) => console.warn("Failed to refresh models:", error));
    });
    this.rpc.on("diagnostic", (line: string) => console.warn(`[codex] ${line}`));
  }

  get codexConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    // 轮询先于连接启动：即使首次连接失败，连接恢复后轮询也能自动接管
    this.pollTimer = setInterval(() => void this.refreshThreads(true), this.config.pollIntervalMs);
    await this.rpc.start();
    await Promise.all([this.refreshThreads(false), this.refreshModels()]);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.rpc.stop();
  }

  async snapshot() {
    if (this.threads.size === 0 && this.connected) await this.refreshThreads(false);
    return {
      connected: this.connected,
      threads: this.sortedThreads(),
      workspaces: await this.listWorkspaces(),
      models: this.models,
      unreadThreadIds: this.db.unreadThreadIds(),
      pendingRequests: this.publicApprovals(),
    };
  }

  async readThread(threadId: string) {
    const pending = this.pendingThreads.get(threadId);
    if (pending) return { thread: pending, preferences: this.db.getPreferences(threadId), nextCursor: null };
    const now = Date.now();
    const listThread = this.threads.get(threadId);
    const listUpdatedAt = listThread?.updatedAt ?? 0;
    const cached = this.readCache.get(threadId);
    if (cached && cached.updatedAt === listUpdatedAt && now - cached.at < READ_CACHE_TTL_MS) {
      return cached.value;
    }
    const [result, history] = await Promise.all([
      this.rpc.request<{ thread: CodexThread }>("thread/read", {
        threadId,
        includeTurns: false,
      }),
      this.readThreadHistory(threadId, null, INITIAL_HISTORY_PAGE_SIZE),
    ]);
    const metadata = rpcResult<{ thread: CodexThread }>(result).thread;
    const archived = this.threads.get(metadata.id)?.archived ?? false;
    const thread = { ...metadata, archived, turns: history.turns };
    this.threads.set(metadata.id, { ...metadata, archived, turns: [] });
    // 读取会话不再调用 thread/resume：读操作应保持无副作用，
    // resume 只在真正发起 turn 时使用（见 startTurn）。
    const fallback = this.db.getPreferences(threadId);
    const preferences = (await this.readPersistedPreferences(thread, fallback)) ?? fallback;
    this.db.setPreferences(threadId, preferences);
    const value = { thread, preferences, nextCursor: history.nextCursor };
    // 短 TTL 结果缓存：吸收快速来回切换会话带来的重复读取
    this.readCache.set(threadId, { at: Date.now(), updatedAt: listUpdatedAt, value });
    this.cachePrune(this.readCache);
    return value;
  }

  async readThreadHistory(threadId: string, cursor: string | null, limit = HISTORY_PAGE_SIZE) {
    const result = await this.rpc.request<{
      data: CodexThread["turns"];
      nextCursor?: string | null;
    }>("thread/turns/list", {
      threadId,
      cursor,
      limit,
      sortDirection: "desc",
      itemsView: "full",
    });
    return {
      turns: [...result.data].reverse(),
      nextCursor: result.nextCursor ?? null,
    };
  }

  async createThread(input: { cwd: string; model?: string | null; effort?: string | null; fullAccess: boolean }) {
    const cwd = this.validateWorkspace(input.cwd);
    const params: JsonObject = {
      cwd,
      model: input.model ?? undefined,
      approvalPolicy: input.fullAccess ? "never" : "on-request",
      sandbox: input.fullAccess ? "danger-full-access" : "workspace-write",
    };
    const result = await this.rpc.request<{ thread: CodexThread; model: string; reasoningEffort: string | null }>(
      "thread/start",
      params,
    );
    const value = rpcResult<{ thread: CodexThread; model: string; reasoningEffort: string | null }>(result);
    const preferences: ThreadPreferences = {
      model: input.model ?? value.model,
      effort: input.effort ?? value.reasoningEffort,
      fullAccess: input.fullAccess,
    };
    this.db.setPreferences(value.thread.id, preferences);
    this.threads.set(value.thread.id, { ...value.thread, archived: false });
    this.pendingThreads.set(value.thread.id, value.thread);
    this.pendingSince.set(value.thread.id, Date.now());
    this.broadcast("threads.changed", { thread: value.thread });
    return { thread: value.thread, preferences };
  }

  async addWorkspace(candidate: string) {
    const workspacePath = this.validateWorkspace(candidate);
    const stat = await fs.stat(workspacePath).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("工作区目录不存在或不是目录");
    this.db.addWorkspacePath(workspacePath);
    const workspaces = await this.listWorkspaces();
    this.broadcast("workspaces.changed", { workspaces });
    return { path: workspacePath, workspaces };
  }

  async startTurn(
    threadId: string,
    input: { text: string; model: string | null; effort: string | null; fullAccess: boolean },
  ) {
    let known = this.threads.get(threadId);
    const pending = this.pendingThreads.get(threadId);
    if (!known && pending) {
      known = { ...pending, archived: false };
      this.threads.set(threadId, known);
    }
    if (!known) {
      await this.readThread(threadId);
      known = this.threads.get(threadId);
    }
    const stored = this.db.getPreferences(threadId);
    const model = input.model ?? stored.model;
    const effort = input.effort ?? stored.effort;
    const preferences: ThreadPreferences = {
      model,
      effort,
      fullAccess: input.fullAccess,
    };
    if (!pending) {
      await this.rpc.request("thread/resume", {
        threadId,
        model: model ?? undefined,
        approvalPolicy: input.fullAccess ? "never" : "on-request",
        sandbox: input.fullAccess ? "danger-full-access" : "workspace-write",
      });
    }
    this.db.setPreferences(threadId, preferences);
    this.db.markRead(threadId);
    const result = await this.rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.text }],
      model: model ?? undefined,
      effort: effort ?? undefined,
      approvalPolicy: input.fullAccess ? "never" : "on-request",
      sandboxPolicy: input.fullAccess
        ? { type: "dangerFullAccess" }
        : {
            type: "workspaceWrite",
            writableRoots: [this.threads.get(threadId)?.cwd].filter(Boolean),
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
      },
    });
    this.pendingThreads.delete(threadId);
    this.pendingSince.delete(threadId);
    return result;
  }

  markRead(threadId: string): void {
    this.db.markRead(threadId);
    this.broadcast("unread.changed", { unreadThreadIds: this.db.unreadThreadIds() });
  }

  setViewer(clientId: string, threadId: string | null): void {
    if (threadId) this.viewers.set(clientId, threadId);
    else this.viewers.delete(clientId);
  }

  removeViewer(clientId: string): void {
    this.viewers.delete(clientId);
  }

  publicApprovals(): Array<ApprovalRequest & { key: string }> {
    return [...this.approvals.entries()].map(([key, request]) => ({ ...request, key }));
  }

  respondToRequest(key: string, body: JsonObject): void {
    const pending = this.approvals.get(key);
    if (!pending) throw new Error("该请求已处理或不存在");
    let result: unknown;
    const accepted = body.decision === "accept";
    switch (pending.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: accepted ? "accept" : "decline" };
        break;
      case "item/tool/requestUserInput":
        result = { answers: body.answers ?? {} };
        break;
      case "mcpServer/elicitation/request":
        result = accepted ? { action: "accept", content: body.content ?? {} } : { action: "decline" };
        break;
      default:
        result = body.result ?? { decision: accepted ? "accept" : "decline" };
    }
    this.rpc.respond(pending.requestId, result);
    this.approvals.delete(key);
    this.broadcast("requests.changed", { pendingRequests: this.publicApprovals() });
  }

  private async refreshModels(): Promise<void> {
    const data: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const result: { data: CodexModel[]; nextCursor: string | null } = await this.rpc.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      data.push(...result.data);
      cursor = result.nextCursor;
    } while (cursor);
    this.models = data;
  }

  private async refreshThreads(stateDbOnly: boolean): Promise<void> {
    if (this.polling || !this.connected) return;
    this.polling = true;
    try {
      const next = new Map<string, CodexThread>();
      for (const archived of [false, true]) {
        let cursor: string | null = null;
        do {
          const result: {
            data: CodexThread[];
            nextCursor: string | null;
          } = await this.rpc.request("thread/list", {
            cursor,
            limit: 100,
            sortKey: "updated_at",
            sortDirection: "desc",
            sourceKinds: SOURCE_KINDS,
            archived,
            useStateDbOnly: stateDbOnly,
          });
          for (const thread of result.data) next.set(thread.id, { ...thread, archived });
          cursor = result.nextCursor;
        } while (cursor);
      }

      for (const [threadId, thread] of this.pendingThreads) {
        if (next.has(threadId)) {
          // 已进入 Codex 状态库，升级为普通会话
          this.pendingThreads.delete(threadId);
          this.pendingSince.delete(threadId);
        } else if (Date.now() - (this.pendingSince.get(threadId) ?? Date.now()) >= PENDING_THREAD_TTL_MS) {
          // 创建失败或从未落库的会话：超时移除，避免永久驻留内存与界面
          this.pendingThreads.delete(threadId);
          this.pendingSince.delete(threadId);
        } else {
          next.set(threadId, { ...thread, archived: false });
        }
      }

      let changed = next.size !== this.threads.size;
      for (const [id, thread] of next) {
        const before = this.threads.get(id);
        if (!before || before.updatedAt !== thread.updatedAt || before.status.type !== thread.status.type) changed = true;
        if (before?.status.type === "active" && thread.status.type !== "active") this.recordCompletion(id);
      }
      this.threads.clear();
      for (const [id, thread] of next) this.threads.set(id, thread);
      if (changed) this.broadcast("threads.changed", { threads: this.sortedThreads() });
    } catch (error) {
      console.warn("Failed to refresh Codex threads:", error);
    } finally {
      this.polling = false;
    }
  }

  private onNotification(message: RpcMessage): void {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (message.method === "thread/started" && params.thread && typeof params.thread === "object") {
      const thread = params.thread as CodexThread;
      this.threads.set(thread.id, { ...thread, archived: false });
    }
    if (message.method === "thread/status/changed" && threadId && params.status && typeof params.status === "object") {
      const thread = this.threads.get(threadId);
      if (thread) thread.status = params.status as CodexThread["status"];
    }
    if (message.method === "turn/completed" && threadId) {
      const thread = this.threads.get(threadId);
      if (thread) thread.status = { type: "idle" };
      this.recordCompletion(threadId);
    }
    if (message.method === "turn/started" && threadId) {
      const thread = this.threads.get(threadId);
      if (thread) thread.status = { type: "active" };
      this.pendingThreads.delete(threadId);
      this.pendingSince.delete(threadId);
    }
    if (message.method === "thread/settings/updated" && threadId && isRecord(params.threadSettings)) {
      const preferences = preferencesFromRuntimeSettings(params.threadSettings, this.db.getPreferences(threadId));
      this.db.setPreferences(threadId, preferences);
      this.broadcast("thread.settings.changed", { threadId, preferences });
    }
    this.broadcast("codex.event", message);
  }

  private onServerRequest(message: RpcMessage): void {
    if (message.id === undefined || !message.method) return;
    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const preferences = threadId ? this.db.getPreferences(threadId) : null;
    if (
      preferences?.fullAccess &&
      (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval")
    ) {
      this.rpc.respond(message.id, { decision: "accept" });
      return;
    }
    const key = requestKey(message.id);
    this.approvals.set(key, {
      requestId: message.id,
      method: message.method,
      params,
      createdAt: Date.now(),
    });
    this.broadcast("requests.changed", { pendingRequests: this.publicApprovals() });
  }

  private recordCompletion(threadId: string): void {
    const beingViewed = [...this.viewers.values()].some((value) => value === threadId);
    if (!beingViewed) this.db.markUnread(threadId);
    this.broadcast("unread.changed", { unreadThreadIds: this.db.unreadThreadIds() });
  }

  private async readPersistedPreferences(thread: CodexThread, fallback: ThreadPreferences): Promise<PersistedSettingsResult> {
    if (!thread.path) return null;
    const now = Date.now();
    const scanCached = this.prefScanCache.get(thread.id);
    if (scanCached && scanCached.threadUpdatedAt === thread.updatedAt && now - scanCached.at < PREF_SCAN_CACHE_TTL_MS) {
      return scanCached.prefs;
    }
    const prefs = await this.scanPersistedPreferences(thread.path, fallback);
    this.prefScanCache.set(thread.id, { at: Date.now(), threadUpdatedAt: thread.updatedAt, prefs });
    this.cachePrune(this.prefScanCache);
    return prefs;
  }

  private async scanPersistedPreferences(filePath: string, fallback: ThreadPreferences): Promise<PersistedSettingsResult> {
    const chunkSize = 64 * 1024;
    try {
      const file = await fs.open(filePath, "r");
      try {
        const size = (await file.stat()).size;
        let position = size;
        let pending = Buffer.alloc(0);
        let scanned = 0;
        while (position > 0) {
          if (scanned >= MAX_PERSISTED_SETTINGS_SCAN_BYTES) return null;
          const length = Math.min(chunkSize, position);
          position -= length;
          scanned += length;
          const buffer = Buffer.allocUnsafe(length);
          await file.read(buffer, 0, length, position);
          const data = Buffer.concat([buffer, pending]);
          let end = data.length;
          for (let index = data.length - 1; index >= 0; index -= 1) {
            if (data[index] !== 10) continue;
            const line = data.subarray(index + 1, end).toString("utf8");
            const settings = persistedSettingsFromLine(line);
            if (settings) return preferencesFromPersistedSettings(settings, fallback);
            end = index;
          }
          pending = data.subarray(0, end);
        }
        const settings = persistedSettingsFromLine(pending.toString("utf8"));
        return settings ? preferencesFromPersistedSettings(settings, fallback) : null;
      } finally {
        await file.close();
      }
    } catch {
      return null;
    }
  }

  private sortedThreads(): CodexThread[] {
    return [...this.threads.values()].sort((a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt));
  }

  private async listWorkspaces(): Promise<Workspace[]> {
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
    return [...paths]
      .map((workspacePath) => {
        const members = [...this.threads.values()].filter((thread) => path.resolve(thread.cwd) === workspacePath);
        return {
          path: workspacePath,
          name: path.basename(workspacePath) || workspacePath,
          threadCount: members.length,
          activeCount: members.filter((thread) => thread.status.type === "active").length,
          latestAt: Math.max(0, ...members.map((thread) => thread.recencyAt ?? thread.updatedAt)),
        };
      })
      .sort((a, b) => b.latestAt - a.latestAt || a.name.localeCompare(b.name));
  }

  private validateWorkspace(candidate: string): string {
    const resolved = path.resolve(candidate);
    const known = new Set([...this.threads.values()].map((thread) => path.resolve(thread.cwd)));
    const insideRoot = this.config.workspaceRoots.some(
      (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
    );
    if (!insideRoot && !known.has(resolved)) throw new Error("工作区不在允许的目录中");
    return resolved;
  }

  private broadcast(type: string, payload: unknown): void {
    this.emit("event", { type, payload, at: Date.now() });
  }
}

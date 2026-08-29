import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
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
  const hasPermissionProfile = profileId !== null || isRecord(settings.permission_profile);
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
    fullAccess: fullAccess || (approvalPolicy === undefined && sandbox === undefined && !hasPermissionProfile ? fallback.fullAccess : false),
  };
};

export const preferencesFromPersistedSettings = (
  settings: JsonObject,
  fallback: ThreadPreferences = { model: null, effort: null, fullAccess: false },
): ThreadPreferences => {
  const profileId = permissionProfileId(settings.active_permission_profile ?? settings.activePermissionProfile);
  const hasPermissionProfile = profileId !== null || isRecord(settings.permission_profile);
  const profileDisabled = isRecord(settings.permission_profile) && settings.permission_profile.type === "disabled";
  const approvalPolicy = settings.approval_policy ?? settings.approvalPolicy;
  const sandbox = settings.sandbox_mode ?? settings.sandbox_policy ?? settings.sandbox ?? settings.sandboxPolicy;
  const fullAccess =
    profileId === ":danger-full-access" ||
    profileDisabled ||
    (approvalPolicy === "never" && sandboxType(sandbox) === "danger-full-access") ||
    (approvalPolicy === "never" && sandboxType(sandbox) === "dangerFullAccess");
  return {
    model: stringValue(settings.model) ?? fallback.model,
    effort: stringValue(settings.reasoning_effort ?? settings.reasoningEffort ?? settings.effort) ?? fallback.effort,
    fullAccess: fullAccess || (approvalPolicy === undefined && sandbox === undefined && !hasPermissionProfile ? fallback.fullAccess : false),
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

const persistedTurnPreferenceEvent = (line: string): { settings?: JsonObject; turnId?: string } | null => {
  try {
    const event = JSON.parse(line) as { type?: unknown; payload?: unknown };
    if (!isRecord(event.payload)) return null;
    const payload = event.payload;
    if (payload.type === "thread_settings_applied" && isRecord(payload.thread_settings)) {
      return { settings: payload.thread_settings };
    }
    const turnId = stringValue(payload.turn_id ?? payload.turnId);
    if (event.type === "turn_context" && turnId) return { settings: payload, turnId };
    if (payload.type === "task_started" && turnId) return { turnId };
    return null;
  } catch {
    return null;
  }
};

export const preferencesByTurnFromPersistedLines = (
  lines: Iterable<string>,
  fallback: ThreadPreferences = { model: null, effort: null, fullAccess: false },
): Map<string, ThreadPreferences> => {
  let current = fallback;
  const result = new Map<string, ThreadPreferences>();
  for (const line of lines) {
    const event = persistedTurnPreferenceEvent(line);
    if (!event) continue;
    if (event.settings) current = preferencesFromPersistedSettings(event.settings, current);
    if (event.turnId) result.set(event.turnId, { ...current });
  }
  return result;
};

type PersistedSettingsResult = ThreadPreferences | null;

const PENDING_THREAD_TTL_MS = 5 * 60_000;
const MAX_PERSISTED_SETTINGS_SCAN_BYTES = 2 * 1024 * 1024;
const READ_CACHE_TTL_MS = 10_000;
const PREF_SCAN_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;
const RECYCLE_IDLE_MS = 5_000;

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
  private readonly readCache = new Map<string, { at: number; updatedAt: number; statusType: CodexThread["status"]["type"]; value: ReadThreadResult }>();
  private readonly prefScanCache = new Map<string, { at: number; threadUpdatedAt: number; prefs: ThreadPreferences | null }>();
  private readonly turnPrefScanCache = new Map<string, { mtimeMs: number; size: number; prefs: Map<string, ThreadPreferences> }>();
  private readonly startedTurnIds = new Map<string, string>();
  private readonly startingTurns = new Set<string>();
  private lastActivityAt = Date.now();
  private recycling = false;
  private recycleArmed = true;
  private models: CodexModel[] = [];
  private approvals = new Map<string, ApprovalRequest>();
  private viewers = new Map<string, string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private started = false;
  private modelsPromise: Promise<void> | null = null;
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
      // 主动回收期间的短暂断开不对外广播，避免状态指示器闪烁
      if (!(this.recycling && !status.connected)) {
        this.broadcast("connection", status);
      }
      // 断线重连后模型列表可能仍为空，主动补拉一次
      if (status.connected) void this.refreshModels().catch((error) => console.warn("Failed to refresh models:", error));
    });
    this.rpc.on("diagnostic", (line: string) => console.warn(`[codex] ${line}`));
  }

  get codexConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    const operation = (async () => {
      // 轮询先于连接启动：即使首次连接失败，连接恢复后轮询也能自动接管。
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => {
          // 先检查回收（refreshThreads 入口会置 polling=true，必须在它之前调用）
          this.maybeRecycle();
          void this.refreshThreads(true);
        }, this.config.pollIntervalMs);
      }
      try {
        await this.rpc.start();
        const initialLoads = await Promise.allSettled([this.refreshThreads(false), this.refreshModels()]);
        for (const result of initialLoads) {
          if (result.status === "rejected") console.warn("Initial Codex state refresh failed:", result.reason);
        }
        this.started = true;
      } catch (error) {
        // 保留轮询定时器：CodexAppServer 会自行重连，连接恢复后轮询才能
        // 自动补齐线程与模型状态。service.stop() 负责最终清理它。
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
    if (
      cached &&
      cached.updatedAt === listUpdatedAt &&
      cached.statusType === listThread?.status.type &&
      now - cached.at < READ_CACHE_TTL_MS
    ) {
      return cached.value;
    }
    const [result, history] = await Promise.all([
      this.rpc.request<{ thread: CodexThread }>("thread/read", {
        threadId,
        includeTurns: false,
      }),
      this.readThreadHistory(threadId, null, INITIAL_HISTORY_PAGE_SIZE),
    ]);
    const metadata = result.thread;
    const archived = this.threads.get(metadata.id)?.archived ?? false;
    const turnPreferences = metadata.path
      ? await this.readPersistedTurnPreferences(metadata.path, this.db.getPreferences(threadId))
      : new Map<string, ThreadPreferences>();
    const turns = history.turns.map((turn) => {
      const preferences = turnPreferences.get(turn.id);
      return preferences ? { ...turn, preferences } : turn;
    });
    const thread = { ...metadata, archived, turns };
    this.threads.set(metadata.id, { ...metadata, archived, turns: [] });
    // 读取会话不再调用 thread/resume：读操作应保持无副作用，
    // resume 只在真正发起 turn 时使用（见 startTurn）。
    const fallback = this.db.getPreferences(threadId);
    const preferences = (await this.readPersistedPreferences(thread, fallback)) ?? fallback;
    this.db.setPreferences(threadId, preferences);
    const value = { thread, preferences, nextCursor: history.nextCursor };
    // 短 TTL 结果缓存：吸收快速来回切换会话带来的重复读取
    this.readCache.set(threadId, {
      at: Date.now(),
      updatedAt: listUpdatedAt,
      statusType: metadata.status.type,
      value,
    });
    this.cachePrune(this.readCache);
    return value;
  }

  async readThreadHistory(threadId: string, cursor: string | null, limit = HISTORY_PAGE_SIZE) {
    const source = this.threads.get(threadId) ?? this.pendingThreads.get(threadId);
    const [result, preferencesByTurn] = await Promise.all([
      this.rpc.request<{
        data: CodexThread["turns"];
        nextCursor?: string | null;
      }>("thread/turns/list", {
        threadId,
        cursor,
        limit,
        sortDirection: "desc",
        itemsView: "full",
      }),
      source?.path
        ? this.readPersistedTurnPreferences(source.path, this.db.getPreferences(threadId))
        : Promise.resolve(new Map<string, ThreadPreferences>()),
    ]);
    return {
      turns: [...result.data].reverse().map((turn) => {
        const preferences = preferencesByTurn.get(turn.id);
        return preferences ? { ...turn, preferences } : turn;
      }),
      nextCursor: result.nextCursor ?? null,
    };
  }

  async createThread(input: { cwd: string; model?: string | null; effort?: string | null; fullAccess: boolean }) {
    const cwd = await this.validateWorkspace(input.cwd);
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
    const value = result;
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
    this.lastActivityAt = Date.now();
    this.recycleArmed = true;
    return { thread: value.thread, preferences };
  }

  async addWorkspace(candidate: string) {
    const workspacePath = await this.validateWorkspace(candidate);
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
    if (!known) throw new Error("会话不存在");
    this.beginTurnStart(threadId, known);
    try {
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
      const result = await this.rpc.request<{ turn?: { id?: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: input.text }],
        model: model ?? undefined,
        effort: effort ?? undefined,
        approvalPolicy: input.fullAccess ? "never" : "on-request",
        sandboxPolicy: input.fullAccess
          ? { type: "dangerFullAccess" }
          : {
              type: "workspaceWrite",
              writableRoots: [known.cwd],
              networkAccess: true,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
      });
      this.pendingThreads.delete(threadId);
      this.pendingSince.delete(threadId);
      if (typeof result.turn?.id === "string") this.startedTurnIds.set(threadId, result.turn.id);
      known.status = { type: "active" };
      this.lastActivityAt = Date.now();
      this.recycleArmed = true;
      return result;
    } finally {
      this.startingTurns.delete(threadId);
    }
  }

  async retryTurn(
    threadId: string,
    input: { text: string; model: string | null; effort: string | null; fullAccess: boolean },
  ) {
    const known = this.threads.get(threadId) ?? this.pendingThreads.get(threadId);
    if (!known) throw new Error("会话不存在");
    this.beginTurnStart(threadId, known);
    try {
      const stored = this.db.getPreferences(threadId);
      const model = input.model ?? stored.model;
      const effort = input.effort ?? stored.effort;
      await this.rpc.request("thread/resume", {
        threadId,
        model: model ?? undefined,
        approvalPolicy: input.fullAccess ? "never" : "on-request",
        sandbox: input.fullAccess ? "danger-full-access" : "workspace-write",
      });
      await this.rpc.request("thread/rollback", { threadId, numTurns: 1 });
      this.readCache.delete(threadId);
      this.prefScanCache.delete(threadId);
      const preferences: ThreadPreferences = { model, effort, fullAccess: input.fullAccess };
      this.db.setPreferences(threadId, preferences);
      this.db.markRead(threadId);
      const result = await this.rpc.request<{ turn?: { id?: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: input.text }],
        model: model ?? undefined,
        effort: effort ?? undefined,
        approvalPolicy: input.fullAccess ? "never" : "on-request",
        sandboxPolicy: input.fullAccess
          ? { type: "dangerFullAccess" }
          : {
              type: "workspaceWrite",
              writableRoots: [known.cwd],
              networkAccess: true,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
      });
      if (typeof result.turn?.id === "string") this.startedTurnIds.set(threadId, result.turn.id);
      known.status = { type: "active" };
      this.lastActivityAt = Date.now();
      this.recycleArmed = true;
      return result;
    } finally {
      this.startingTurns.delete(threadId);
    }
  }

  private beginTurnStart(threadId: string, thread: CodexThread): void {
    if (this.startingTurns.has(threadId) || this.startedTurnIds.has(threadId) || thread.status.type === "active") {
      throw new Error("该会话已有任务正在执行");
    }
    this.startingTurns.add(threadId);
  }

  async cancelTurn(threadId: string, turnId?: string) {
    const known = this.threads.get(threadId) ?? this.pendingThreads.get(threadId);
    if (!known) throw new Error("会话不存在");
    const target = turnId ?? this.startedTurnIds.get(threadId);
    if (!target) throw new Error("未找到正在执行的任务");
    const result = await this.rpc.request("turn/interrupt", { threadId, turnId: target });
    // 清理该会话遗留的待处理审批请求
    let approvalsChanged = false;
    for (const [key, request] of this.approvals) {
      if (typeof request.params.threadId === "string" && request.params.threadId === threadId) {
        this.approvals.delete(key);
        approvalsChanged = true;
      }
    }
    if (approvalsChanged) this.broadcast("requests.changed", { pendingRequests: this.publicApprovals() });
    this.startedTurnIds.delete(threadId);
    // 乐观更新本地状态并广播：codex 的完成通知随后到达时会被幂等覆盖
    const thread = this.threads.get(threadId);
    if (thread) thread.status = { type: "idle" };
    this.broadcast("threads.changed", { threads: this.sortedThreads() });
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

  async runCommand(threadId: string, command: string, args: string | undefined) {
    const known = this.threads.get(threadId) ?? this.pendingThreads.get(threadId);
    if (!known) throw new Error("会话不存在");
    switch (command) {
      case "rename": {
        if (!args?.trim()) throw new Error("请提供新名称：/rename <名称>");
        await this.rpc.request("thread/name/set", { threadId, name: args.trim() });
        const thread = this.threads.get(threadId);
        if (thread) thread.name = args.trim();
        break;
      }
      case "archive": {
        await this.rpc.request("thread/archive", { threadId });
        const thread = this.threads.get(threadId);
        if (thread) thread.archived = true;
        break;
      }
      case "unarchive": {
        await this.rpc.request("thread/unarchive", { threadId });
        const thread = this.threads.get(threadId);
        if (thread) thread.archived = false;
        break;
      }
      case "compact": {
        // compact 只对当前 app-server 已加载的会话生效：先尝试 resume（失败时
        // 由 compact 调用自身报错，例如会话被其他进程占用）
        await this.rpc.request("thread/resume", { threadId }).catch(() => undefined);
        await this.rpc.request("thread/compact/start", { threadId });
        break;
      }
      case "goal": {
        if (!args?.trim()) throw new Error("请提供目标内容：/goal <目标>");
        await this.rpc.request("thread/goal/set", { threadId, objective: args.trim() });
        break;
      }
      case "steer": {
        if (!args?.trim()) throw new Error("请提供追加指令：/steer <指令>");
        const turnId = this.startedTurnIds.get(threadId);
        if (!turnId) throw new Error("当前没有进行中的任务");
        await this.rpc.request("turn/steer", {
          threadId,
          input: [{ type: "text", text: args.trim() }],
          expectedTurnId: turnId,
        });
        break;
      }
      default:
        throw new Error("未知命令");
    }
    this.readCache.delete(threadId);
    this.broadcast("threads.changed", { threads: this.sortedThreads() });
    return { ok: true };
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

  // codex 的会话写锁会一直持有到 app-server 卸载会话或进程退出。
  // 任务完成后主动重启子进程，释放写锁并让服务器上的 codex CLI 立即 resume。
  private maybeRecycle(): void {
    if (!this.recycleArmed || this.recycling || !this.connected || this.polling) return;
    const hasActiveTurn = [...this.threads.values()].some((thread) => thread.status.type === "active");
    if (hasActiveTurn || this.approvals.size > 0) return;
    if (Date.now() - this.lastActivityAt < RECYCLE_IDLE_MS) return;
    this.recycling = true;
    // 每次空闲期只回收一次；有新活动后重新武装
    this.recycleArmed = false;
    void this.rpc
      .restart(1_500)
      .catch((error) => console.warn("Codex recycle restart failed:", error))
      .finally(() => {
        this.recycling = false;
      });
  }

  private async refreshModels(): Promise<void> {
    if (this.modelsPromise) return this.modelsPromise;
    const operation = this.loadModels();
    this.modelsPromise = operation;
    try {
      await operation;
    } finally {
      if (this.modelsPromise === operation) this.modelsPromise = null;
    }
  }

  private async loadModels(): Promise<void> {
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
        if (
          !before ||
          before.updatedAt !== thread.updatedAt ||
          before.status.type !== thread.status.type ||
          before.name !== thread.name ||
          before.archived !== thread.archived ||
          before.preview !== thread.preview
        ) changed = true;
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
      this.startedTurnIds.delete(threadId);
      this.recordCompletion(threadId);
    }
    if (message.method === "turn/started" && threadId) {
      const thread = this.threads.get(threadId);
      if (thread) thread.status = { type: "active" };
      if (isRecord(params.turn) && typeof params.turn.id === "string") {
        this.startedTurnIds.set(threadId, params.turn.id);
      }
      this.pendingThreads.delete(threadId);
      this.pendingSince.delete(threadId);
      this.lastActivityAt = Date.now();
      this.recycleArmed = true;
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

  private async readPersistedTurnPreferences(
    filePath: string,
    fallback: ThreadPreferences,
  ): Promise<Map<string, ThreadPreferences>> {
    try {
      const stat = await fs.stat(filePath);
      const cached = this.turnPrefScanCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.prefs;

      let current = fallback;
      const prefs = new Map<string, ThreadPreferences>();
      const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
      for await (const line of lines) {
        const event = persistedTurnPreferenceEvent(line);
        if (!event) continue;
        if (event.settings) current = preferencesFromPersistedSettings(event.settings, current);
        if (event.turnId) prefs.set(event.turnId, { ...current });
      }
      this.turnPrefScanCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, prefs });
      this.cachePrune(this.turnPrefScanCache);
      return prefs;
    } catch {
      return new Map();
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

import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  Folder,
  FolderPlus,
  Folders,
  LogOut,
  Plus,
  Search,
  Server,
  ShieldAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import webPackage from "../../package.json";
import { EmptyConversation, IconButton, SidebarHeading, ThreadRow } from "../shared/components";
import { ConfirmDeleteDialog, NewThreadDialog, WorkspaceDialog } from "../shared/dialogs";
import { errorMessage, isRecord, readSelection, relativeTime, writeSelection } from "../shared/lib";
import { useActivityRefresh } from "../shared/useActivityRefresh";
import type { AuthState, PendingRequest, Workspace } from "../shared/types";
import type { CodexApiClient } from "./api";
import { ApprovalBar, Conversation } from "./conversation";
import {
  cloneThread,
  mergeHistoricalTurns,
  mergeTurn,
  normalizePreferences,
  sourceLabel,
  threadTitle,
  userMessageText,
} from "./lib";
import type { Preferences, Snapshot, Thread, ThreadItem, Turn } from "./types";

const emptySnapshot: Snapshot = {
  connected: false,
  threads: [],
  workspaces: [],
  models: [],
  unreadThreadIds: [],
  pendingRequests: [],
};

const SELECTION_KEYS = {
  workspace: "codex-ui.selected-workspace",
  thread: "codex-ui.selected-thread",
  sidebar: "codex-ui.sidebar-collapsed",
} as const;

const THREAD_CACHE_MAX = 25;
const READ_TIMEOUT_MS = 20_000;

type ThreadCacheEntry = {
  thread: Thread;
  preferences: Preferences;
  historyCursor: string | null;
};

export function CodexDashboard({
  api,
  auth,
  onAuthChange,
  switcher,
}: {
  api: CodexApiClient;
  auth: AuthState;
  onAuthChange: (value: AuthState) => void;
  switcher?: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>(() => readSelection(SELECTION_KEYS.workspace) ?? "");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => readSelection(SELECTION_KEYS.thread));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSelection(SELECTION_KEYS.sidebar) === "true");
  const [detail, setDetail] = useState<Thread | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>({ model: null, effort: null, fullAccess: false });
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<"workspace" | null>(null);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [approvalPanelOpen, setApprovalPanelOpen] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Thread | null>(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
  const restoreThreadRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const autoHistoryRef = useRef(true);
  const detailRef = useRef<Thread | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadCacheRef = useRef<Map<string, ThreadCacheEntry>>(new Map());
  const authRef = useRef(auth);
  authRef.current = auth;

  selectedRef.current = selectedThreadId;

  useEffect(() => {
    writeSelection(SELECTION_KEYS.workspace, selectedWorkspace || null);
  }, [selectedWorkspace]);

  useEffect(() => {
    writeSelection(SELECTION_KEYS.thread, selectedThreadId);
  }, [selectedThreadId]);

  useEffect(() => {
    writeSelection(SELECTION_KEYS.sidebar, sidebarCollapsed ? "true" : null);
  }, [sidebarCollapsed]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const updateActivityExpiry = useCallback((expiresAt: number) => {
    const current = authRef.current;
    if (!current.authenticated) return;
    onAuthChange({ ...current, expiresAt });
  }, [onAuthChange]);

  useActivityRefresh(api, auth, updateActivityExpiry, onAuthChange);

  // 安全发送 viewing 消息：连接未就绪时跳过——open 事件会用 selectedRef 补发当前选择，
  // 对 CONNECTING/CLOSED 状态直接 send 会抛 InvalidStateError 并触发错误边界
  const sendViewing = useCallback((threadId: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "viewing", backend: "codex", threadId }));
    } catch {
      // 发送失败可忽略：重连后的 open 事件会重新同步选择
    }
  }, []);

  const updateSnapshot = useCallback((incoming: Partial<Snapshot>) => {
    setSnapshot((current) => ({ ...current, ...incoming }));
  }, []);

  const commitDetail = useCallback((threadId: string, thread: Thread) => {
    detailRef.current = thread;
    setDetail(thread);
    const entry = threadCacheRef.current.get(threadId);
    if (entry) threadCacheRef.current.set(threadId, { ...entry, thread });
  }, []);

  const pruneThreadCache = useCallback(() => {
    const cache = threadCacheRef.current;
    while (cache.size > THREAD_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);

  const applyCodexEvent = useCallback((message: { method?: string; params?: Record<string, unknown> }) => {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) return;

    setSnapshot((current) => ({
      ...current,
      threads: current.threads.map((thread) => {
        if (thread.id !== threadId) return thread;
        if (message.method === "turn/started") return { ...thread, status: { type: "active" } };
        if (message.method === "turn/completed") return { ...thread, status: { type: "idle" }, updatedAt: Math.floor(Date.now() / 1000) };
        if (message.method === "thread/status/changed" && params.status) return { ...thread, status: params.status as Thread["status"] };
        return thread;
      }),
    }));

    if (selectedRef.current !== threadId) return;
    const current = detailRef.current;
    if (!current) return;
    commitDetail(threadId, mutateThreadFromEvent(current, message));
  }, [commitDetail]);

  useEffect(() => {
    let cancelled = false;
    void api
      .bootstrap()
      .then((value) => {
        if (!cancelled) {
          setSnapshot(value);
          const savedWorkspace = readSelection(SELECTION_KEYS.workspace);
          const savedThreadId = readSelection(SELECTION_KEYS.thread);
          const restoredThread = value.threads.find((thread) => thread.id === savedThreadId);
          const workspace = restoredThread?.cwd
            ?? (savedWorkspace && value.workspaces.some((entry) => entry.path === savedWorkspace) ? savedWorkspace : null)
            ?? value.workspaces[0]?.path
            ?? "";
          setSelectedWorkspace(workspace);
          setSelectedThreadId(restoredThread?.id ?? null);
          restoreThreadRef.current = restoredThread?.id ?? null;
        }
      })
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let stopped = false;
    let retryTimer: number | undefined;
    let retryDelay = 1_000;

    const connect = () => {
      if (stopped) return;
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${scheme}//${location.host}/ws`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        retryDelay = 1_000;
        if (selectedRef.current) sendViewing(selectedRef.current);
      });
      socket.addEventListener("message", (event) => {
        let message: { type: string; backend?: string; payload?: unknown };
        try {
          message = JSON.parse(event.data) as { type: string; backend?: string; payload?: unknown };
        } catch {
          return;
        }
        if (message.type === "auth.expired") {
          onAuthChange({ authenticated: false });
          return;
        }
        if (message.backend && message.backend !== "codex") return;
        if (message.type === "snapshot" && isRecord(message.payload)) updateSnapshot(message.payload as Snapshot);
        if (message.type === "connection") updateSnapshot({ connected: Boolean((message.payload as { connected?: boolean })?.connected) });
        if (message.type === "threads.changed") {
          const payload = isRecord(message.payload) ? message.payload as { threads?: unknown; thread?: unknown } : {};
          if (Array.isArray(payload.threads)) updateSnapshot({ threads: payload.threads as Thread[] });
          if (isRecord(payload.thread) && typeof payload.thread.id === "string") {
            setSnapshot((current) => ({
              ...current,
              threads: [payload.thread as Thread, ...current.threads.filter((thread) => thread.id !== (payload.thread as Thread).id)],
            }));
          }
        }
        if (message.type === "workspaces.changed") {
          const workspaces = isRecord(message.payload) ? message.payload.workspaces : undefined;
          if (Array.isArray(workspaces)) updateSnapshot({ workspaces: workspaces as Workspace[] });
        }
        if (message.type === "unread.changed") {
          const unreadThreadIds = isRecord(message.payload) ? message.payload.unreadThreadIds : undefined;
          if (Array.isArray(unreadThreadIds)) updateSnapshot({ unreadThreadIds: unreadThreadIds.filter((id): id is string => typeof id === "string") });
        }
        if (message.type === "requests.changed") {
          const pendingRequests = isRecord(message.payload) ? message.payload.pendingRequests : undefined;
          if (Array.isArray(pendingRequests)) updateSnapshot({ pendingRequests: pendingRequests as PendingRequest[] });
        }
        if (message.type === "thread.settings.changed") {
          const payload = isRecord(message.payload) ? message.payload : {};
          if (payload.threadId === selectedRef.current && isRecord(payload.preferences)) {
            setPreferences(payload.preferences as Preferences);
          }
        }
        if (message.type === "codex.event") applyCodexEvent(message.payload as { method?: string; params?: Record<string, unknown> });
      });
      socket.addEventListener("close", () => {
        updateSnapshot({ connected: false });
        if (!stopped) {
          retryTimer = window.setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 15_000);
        }
      });
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socketRef.current = null;
    };
  }, [applyCodexEvent, onAuthChange, sendViewing, updateSnapshot]);

  const maybeMarkRead = useCallback((threadId: string) => {
    if (!snapshot.unreadThreadIds.includes(threadId)) return;
    void api
      .markRead(threadId)
      .then(({ unreadThreadIds }) => updateSnapshot({ unreadThreadIds }))
      .catch(() => undefined);
  }, [api, snapshot.unreadThreadIds, updateSnapshot]);

  const applyThreadLoad = useCallback(
    (threadId: string, value: { thread: Thread; preferences: Preferences; nextCursor: string | null }) => {
      threadCacheRef.current.set(threadId, {
        thread: value.thread,
        preferences: value.preferences,
        historyCursor: value.nextCursor,
      });
      pruneThreadCache();
      detailRef.current = value.thread;
      setDetail(value.thread);
      setHistoryCursor(value.nextCursor);
      setPreferences(normalizePreferences(value.preferences, snapshot.models));
    },
    [pruneThreadCache, snapshot.models],
  );

  const selectThread = (thread: Thread) => {
    const requestId = ++detailRequestRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSelectedThreadId(thread.id);
    setSelectedWorkspace(thread.cwd);
    setDrawer(null);
    setError("");
    sendViewing(thread.id);

    const cached = threadCacheRef.current.get(thread.id);
    const stale = cached !== undefined && (
      cached.thread.updatedAt !== thread.updatedAt || cached.thread.status.type !== thread.status.type
    );

    if (cached && !stale) {
      // 缓存命中：立即渲染，不出现整屏加载
      autoHistoryRef.current = false;
      setHistoryLoading(false);
      setDetailLoading(false);
      detailRef.current = cached.thread;
      setDetail(cached.thread);
      setHistoryCursor(cached.historyCursor);
      setPreferences(normalizePreferences(cached.preferences, snapshot.models));
      maybeMarkRead(thread.id);
      return;
    }

    // 缓存未命中（或已过期）：需要加载。过期缓存先展示、后台静默刷新。
    // 手动超时（不用 AbortSignal.any/timeout，兼容 iOS<17.4 等旧移动浏览器）
    let timedOut = false;
    const timeoutTimer = window.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("加载超时", "TimeoutError"));
    }, READ_TIMEOUT_MS);
    const signal = controller.signal;
    autoHistoryRef.current = true;
    setHistoryLoading(false);
    setDetailLoading(cached === undefined);
    if (cached) {
      detailRef.current = cached.thread;
      setDetail(cached.thread);
      setHistoryCursor(cached.historyCursor);
      setPreferences(normalizePreferences(cached.preferences, snapshot.models));
    } else {
      detailRef.current = null;
      setDetail(null);
      setHistoryCursor(null);
    }

    const load = async (): Promise<void> => {
      const value = await api.readThread(thread.id, { signal });
      if (detailRequestRef.current !== requestId) return;
      applyThreadLoad(thread.id, value);
      setDetailLoading(false);
      void api.markRead(thread.id, { signal })
        .then(({ unreadThreadIds }) => updateSnapshot({ unreadThreadIds }))
        .catch(() => undefined);
    };

    void load()
      .catch((reason: unknown) => {
        if (detailRequestRef.current !== requestId) return;
        if (timedOut) {
          const staleEntry = threadCacheRef.current.get(thread.id);
          if (staleEntry) {
            detailRef.current = staleEntry.thread;
            setDetail(staleEntry.thread);
            setHistoryCursor(staleEntry.historyCursor);
            setError("刷新超时，正在显示稍早的内容");
          } else {
            setDetail(null);
            setHistoryCursor(null);
            setError("加载超时，请重新点击会话重试");
          }
          return;
        }
        if (controller.signal.aborted) return; // 已被新选择取代
        const staleEntry = threadCacheRef.current.get(thread.id);
        if (staleEntry) {
          // 刷新失败：继续使用过期缓存，仅提示错误
          detailRef.current = staleEntry.thread;
          setDetail(staleEntry.thread);
          setHistoryCursor(staleEntry.historyCursor);
          setError(errorMessage(reason));
        } else {
          setDetail(null);
          setHistoryCursor(null);
          setError(errorMessage(reason));
        }
      })
      .finally(() => {
        window.clearTimeout(timeoutTimer);
        if (detailRequestRef.current === requestId) setDetailLoading(false);
      });
  };

  useEffect(() => {
    const threadId = restoreThreadRef.current;
    if (!threadId || detail || detailLoading) return;
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (!thread) return;
    restoreThreadRef.current = null;
    try {
      selectThread(thread);
    } catch (error) {
      // 恢复流程不应让整页进入错误边界；失败时保持列表视图即可
      console.error("Failed to restore thread:", error);
    }
  }, [detail, detailLoading, selectedThreadId, snapshot.threads]);

  const fetchOlderHistory = useCallback(() => {
    if (!detail || detailLoading || historyLoading || !historyCursor) return;
    const listStatus = snapshot.threads.find((entry) => entry.id === detail.id)?.status.type;
    if (detail.status.type === "active" || listStatus === "active") return;
    const threadId = detail.id;
    const cursor = historyCursor;
    const requestId = detailRequestRef.current;
    const signal = abortRef.current?.signal;
    setHistoryLoading(true);
    void api
      .readThreadHistory(threadId, cursor, { signal })
      .then((page) => {
        if (detailRequestRef.current !== requestId || selectedRef.current !== threadId) return;
        const current = detailRef.current;
        if (!current || current.id !== threadId) return;
        commitDetail(threadId, { ...current, turns: mergeHistoricalTurns(page.turns, current.turns) });
        setHistoryCursor(page.nextCursor);
        const entry = threadCacheRef.current.get(threadId);
        if (entry) threadCacheRef.current.set(threadId, { ...entry, historyCursor: page.nextCursor });
      })
      .catch((reason) => {
        if (signal?.aborted || detailRequestRef.current !== requestId) return;
        setHistoryCursor(null);
        setError(`较早历史记录加载失败：${errorMessage(reason)}`);
      })
      .finally(() => {
        if (detailRequestRef.current === requestId) setHistoryLoading(false);
      });
  }, [api, commitDetail, detail, detailLoading, historyCursor, historyLoading, snapshot.threads]);

  // 打开会话后自动补一页较早记录；更多历史由「加载更早的记录」按钮按需拉取，
  // 避免对超大会话产生无休止的顺序请求。
  useEffect(() => {
    if (!autoHistoryRef.current || !detail || detailLoading || historyLoading || !historyCursor) return;
    if (detail.status.type === "active") return;
    autoHistoryRef.current = false;
    fetchOlderHistory();
  }, [detail, detailLoading, fetchOlderHistory, historyCursor, historyLoading]);

  const filteredThreads = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return snapshot.threads.filter((thread) => !query || threadTitle(thread).toLocaleLowerCase().includes(query));
  }, [search, snapshot.threads]);

  const threadsByWorkspace = useMemo(() => {
    const grouped = new Map<string, Thread[]>();
    for (const thread of filteredThreads) {
      const current = grouped.get(thread.cwd) ?? [];
      current.push(thread);
      grouped.set(thread.cwd, current);
    }
    return grouped;
  }, [filteredThreads]);

  const selectedThread = snapshot.threads.find((thread) => thread.id === selectedThreadId) ?? detail;
  const threadPending = snapshot.pendingRequests.filter((request) => request.params.threadId === selectedThread?.id);
  const otherPending = snapshot.pendingRequests.filter((request) => request.params.threadId !== selectedThread?.id);

  const selectWorkspace = (workspacePath: string) => {
    setSelectedWorkspace(workspacePath);
    setDrawer("workspace");
    if (!selectedThread || selectedThread.cwd === workspacePath) return;
    detailRequestRef.current += 1;
    abortRef.current?.abort();
    setSelectedThreadId(null);
    detailRef.current = null;
    setDetail(null);
    setHistoryCursor(null);
    setHistoryLoading(false);
    setDetailLoading(false);
  };

  useEffect(() => {
    if (approvalPanelOpen && otherPending.length === 0) setApprovalPanelOpen(false);
  }, [approvalPanelOpen, otherPending.length]);

  const createThread = async (cwd: string) => {
    const defaultModel = snapshot.models.find((model) => model.isDefault) ?? snapshot.models[0];
    const result = await api.createThread({
      cwd,
      model: defaultModel?.model ?? null,
      effort: defaultModel?.defaultReasoningEffort ?? null,
      fullAccess: false,
    });
    detailRequestRef.current += 1;
    abortRef.current?.abort();
    autoHistoryRef.current = false;
    threadCacheRef.current.set(result.thread.id, {
      thread: result.thread,
      preferences: result.preferences,
      historyCursor: null,
    });
    pruneThreadCache();
    setSnapshot((current) => ({
      ...current,
      threads: [result.thread, ...current.threads.filter((thread) => thread.id !== result.thread.id)],
    }));
    setSelectedWorkspace(cwd);
    setSelectedThreadId(result.thread.id);
    detailRef.current = result.thread;
    setDetail(result.thread);
    setHistoryCursor(null);
    setHistoryLoading(false);
    setDetailLoading(false);
    setPreferences(result.preferences);
    setNewThreadOpen(false);
    sendViewing(result.thread.id);
  };

  const addWorkspace = async (workspacePath: string) => {
    const result = await api.addWorkspace(workspacePath);
    updateSnapshot({ workspaces: result.workspaces });
    setSelectedWorkspace(result.path);
    setWorkspaceDialogOpen(false);
    setDrawer("workspace");
  };

  const confirmDeleteThread = async (thread: Thread) => {
    setDeletingThreadId(thread.id);
    try {
      await api.deleteThread(thread.id);
    } finally {
      setDeletingThreadId(null);
    }
    // 成功后清理本地状态；列表移除由 WS threads.changed 广播兜底，这里先做即时反馈
    threadCacheRef.current.delete(thread.id);
    setSnapshot((current) => ({
      ...current,
      threads: current.threads.filter((entry) => entry.id !== thread.id),
    }));
    if (selectedRef.current === thread.id) {
      detailRequestRef.current += 1;
      abortRef.current?.abort();
      autoHistoryRef.current = false;
      setSelectedThreadId(null);
      detailRef.current = null;
      setDetail(null);
      setHistoryCursor(null);
      setHistoryLoading(false);
      setDetailLoading(false);
    }
    setDeleteCandidate(null);
  };

  const appendStartedTurn = (threadId: string, turn: Turn) => {
    const current = detailRef.current;
    if (!current || current.id !== threadId) return;
    const index = current.turns.findIndex((entry) => entry.id === turn.id);
    const turns = [...current.turns];
    const existing = index >= 0 ? turns[index] : undefined;
    if (existing) turns[index] = mergeTurn(existing, turn);
    else turns.push(turn);
    commitDetail(threadId, { ...current, status: { type: "active" }, turns });
  };

  const markTurnCancelled = (threadId: string) => {
    const current = detailRef.current;
    if (current && current.id === threadId) {
      const now = Math.floor(Date.now() / 1000);
      commitDetail(threadId, {
        ...current,
        status: { type: "idle" },
        turns: current.turns.map((turn) =>
          turn.status === "inProgress"
            ? { ...turn, status: "interrupted", completedAt: turn.completedAt ?? now }
            : turn,
        ),
      });
    }
    setSnapshot((snap) => ({
      ...snap,
      threads: snap.threads.map((thread) =>
        thread.id === threadId ? { ...thread, status: { type: "idle" } } : thread,
      ),
    }));
  };

  const markTurnRetried = (threadId: string, turn: Turn, rolledBackId?: string) => {
    const current = detailRef.current;
    if (current && current.id === threadId) {
      // 服务端已回滚旧轮次。WS 事件可能已先行把新轮次追加进列表：
      // 按 id 精确移除旧轮次并去重新轮次，而不是依赖位置。
      if (rolledBackId) suppressTurn(rolledBackId);
      const turns = [
        ...current.turns.filter((entry) => entry.id !== rolledBackId && entry.id !== turn.id),
        turn,
      ];
      commitDetail(threadId, { ...current, status: { type: "active" }, turns });
    }
    setSnapshot((snap) => ({
      ...snap,
      threads: snap.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, status: { type: "active" }, updatedAt: Math.floor(Date.now() / 1000) }
          : thread,
      ),
    }));
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      onAuthChange({ authenticated: false });
    }
  };

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-mark small"><Code2 size={19} /></div>
          <strong>Codex UI</strong><span className="app-version">v{webPackage.version}</span>
          {switcher}
        </div>
        <div className="mobile-nav-actions">
          <IconButton title="工作区与会话" onClick={() => setDrawer(drawer === "workspace" ? null : "workspace")}><Folders size={19} /></IconButton>
        </div>
        <div className="topbar-actions">
          <span className={`connection-pill ${snapshot.connected ? "online" : "offline"}`}>
            <span className="status-dot" />{snapshot.connected ? "Codex 在线" : "Codex 断开"}
          </span>
          <button
            className={`icon-button approval-indicator ${otherPending.length > 0 ? "highlighted" : ""}`}
            title="其他会话的待处理请求"
            aria-label={`待处理请求${otherPending.length > 0 ? `（${otherPending.length}）` : ""}`}
            onClick={() => setApprovalPanelOpen(true)}
          >
            <ShieldAlert size={18} />
            {otherPending.length > 0 && <span className="count-badge">{otherPending.length}</span>}
          </button>
          <IconButton title="退出登录" onClick={() => void logout()}><LogOut size={18} /></IconButton>
        </div>
      </header>

      <aside className={`workspace-sidebar ${sidebarCollapsed ? "collapsed" : ""} ${drawer === "workspace" ? "drawer-open" : ""}`}>
        <SidebarHeading
          icon={<Folders size={17} />}
          title="工作区与会话"
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((current) => !current)}
          onClose={() => setDrawer(null)}
        />
        <div className="thread-tools">
          <button className="new-thread-button" onClick={() => setNewThreadOpen(true)} disabled={!selectedWorkspace}>
            <Plus size={17} />新建会话
          </button>
          <label className="search-box">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话" />
          </label>
        </div>
        <nav className="workspace-list" aria-label="工作区与会话">
          {snapshot.workspaces.map((workspace) => {
            const threads = threadsByWorkspace.get(workspace.path) ?? [];
            const expanded = selectedWorkspace === workspace.path || search.trim().length > 0;
            if (search.trim() && threads.length === 0) return null;
            return (
              <section className={`workspace-group ${expanded ? "expanded" : ""}`} key={workspace.path}>
                <button
                  className={`workspace-row ${selectedWorkspace === workspace.path ? "selected" : ""}`}
                  onClick={() => selectWorkspace(workspace.path)}
                >
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <Folder size={17} />
                  <span className="workspace-copy"><strong>{workspace.name}</strong><small>{workspace.path}</small></span>
                  <span className="count-badge">{workspace.threadCount}</span>
                  {workspace.activeCount > 0 && <span className="active-pip" title="有任务进行中" />}
                </button>
                {expanded && (
                  <div className="workspace-threads" aria-label={`${workspace.name} 下的会话`}>
                    {threads.map((thread) => (
                      <ThreadRow
                        key={thread.id}
                        title={threadTitle(thread)}
                        meta={sourceLabel(thread.source)}
                        time={relativeTime((thread.recencyAt ?? thread.updatedAt) * 1000)}
                        active={thread.status.type === "active"}
                        archived={thread.archived}
                        unread={snapshot.unreadThreadIds.includes(thread.id)}
                        selected={thread.id === selectedThreadId}
                        onSelect={() => void selectThread(thread)}
                        onDelete={() => setDeleteCandidate(thread)}
                        deleting={deletingThreadId === thread.id}
                      />
                    ))}
                    {!loading && threads.length === 0 && <div className="empty-sidebar">暂无会话</div>}
                  </div>
                )}
              </section>
            );
          })}
          {!loading && snapshot.workspaces.length === 0 && <div className="empty-sidebar">暂无工作区</div>}
        </nav>
        <div className="sidebar-footer">
          <span className="sidebar-footer-copy"><Server size={15} />{snapshot.workspaces.length} 个工作区</span>
          <IconButton title="新增工作区" onClick={() => setWorkspaceDialogOpen(true)}><FolderPlus size={17} /></IconButton>
        </div>
      </aside>

      {(drawer || newThreadOpen || workspaceDialogOpen || approvalPanelOpen || deleteCandidate) && (
        <button className="backdrop" aria-label="关闭" onClick={() => { setDrawer(null); setNewThreadOpen(false); setWorkspaceDialogOpen(false); setApprovalPanelOpen(false); setDeleteCandidate(null); }} />
      )}

      <section className="conversation-pane">
        {error && <div className="global-error"><CircleAlert size={17} />{error}<button onClick={() => setError("")} aria-label="关闭"><X size={16} /></button></div>}
        {!selectedThread ? (
          <EmptyConversation onCreate={() => setNewThreadOpen(true)} disabled={!selectedWorkspace} />
        ) : (
          <Conversation
            key={selectedThread.id}
            api={api}
            thread={detail ?? selectedThread}
            listThread={selectedThread}
            models={snapshot.models}
            preferences={preferences}
            pendingRequests={threadPending}
            loading={detailLoading}
            loadingOlder={historyLoading}
            hasOlder={historyCursor !== null}
            onLoadOlder={fetchOlderHistory}
            onTurnStarted={appendStartedTurn}
            onTurnCancelled={markTurnCancelled}
            onTurnRetried={markTurnRetried}
            onNewThread={() => setNewThreadOpen(true)}
            onPreferencesChange={setPreferences}
            onError={setError}
            onRequestsChange={(pendingRequests) => updateSnapshot({ pendingRequests })}
          />
        )}
      </section>

      {newThreadOpen && (
        <NewThreadDialog
          workspaces={snapshot.workspaces}
          initialWorkspace={selectedWorkspace}
          onClose={() => setNewThreadOpen(false)}
          onCreate={createThread}
        />
      )}

      {workspaceDialogOpen && (
        <WorkspaceDialog
          onClose={() => setWorkspaceDialogOpen(false)}
          onAdd={addWorkspace}
        />
      )}

      {deleteCandidate && (
        <ConfirmDeleteDialog
          title={threadTitle(deleteCandidate)}
          onClose={() => setDeleteCandidate(null)}
          onConfirm={() => confirmDeleteThread(deleteCandidate)}
        />
      )}

      {approvalPanelOpen && (
        <section className="dialog approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-dialog-title">
          <header><div><ShieldAlert size={18} /><h2 id="approval-dialog-title">其他会话的待处理请求</h2></div><IconButton title="关闭" onClick={() => setApprovalPanelOpen(false)}><X size={18} /></IconButton></header>
          <div className="dialog-body">
            {otherPending.length === 0 ? (
              <p className="approval-empty">当前没有待处理请求。</p>
            ) : (
              <ApprovalBar
                api={api}
                requests={otherPending}
                onError={setError}
                onRequestsChange={(pendingRequests) => updateSnapshot({ pendingRequests })}
              />
            )}
          </div>
        </section>
      )}
    </main>
  );
}

// 被回滚（修改重发）的轮次 id：codex 回滚后会补发这些轮次的完成事件，
// 忽略它们以防旧对话内容被重新追加到界面
const SUPPRESSED_TURN_IDS = new Set<string>();

const suppressTurn = (turnId: string): void => {
  SUPPRESSED_TURN_IDS.add(turnId);
  while (SUPPRESSED_TURN_IDS.size > 1_000) {
    const oldest = SUPPRESSED_TURN_IDS.values().next().value;
    if (oldest === undefined) break;
    SUPPRESSED_TURN_IDS.delete(oldest);
  }
};

function mutateThreadFromEvent(thread: Thread, message: { method?: string; params?: Record<string, unknown> }): Thread {
  const next = cloneThread(thread);
  const params = message.params ?? {};
  const turnId = typeof params.turnId === "string" ? params.turnId : isRecord(params.turn) && typeof params.turn.id === "string" ? params.turn.id : null;
  if (turnId && SUPPRESSED_TURN_IDS.has(turnId)) return next;
  if (message.method === "turn/started" && isRecord(params.turn)) {
    const turn = params.turn as Turn;
    const index = next.turns.findIndex((entry) => entry.id === turn.id);
    const existing = index >= 0 ? next.turns[index] : undefined;
    if (existing) next.turns[index] = mergeTurn(existing, turn);
    else next.turns.push(turn);
    next.status = { type: "active" };
    return next;
  }
  if (message.method === "turn/completed" && isRecord(params.turn)) {
    const turn = params.turn as Turn;
    const index = next.turns.findIndex((entry) => entry.id === turn.id);
    const existing = index >= 0 ? next.turns[index] : undefined;
    if (existing) next.turns[index] = mergeTurn(existing, turn);
    else next.turns.push(turn);
    next.status = { type: "idle" };
    return next;
  }
  if (message.method === "turn/completed") {
    const turn = turnId ? next.turns.find((entry) => entry.id === turnId) : undefined;
    if (turn) {
      turn.status = "completed";
      turn.completedAt = turn.completedAt ?? Math.floor(Date.now() / 1000);
    }
    next.status = { type: "idle" };
    return next;
  }
  if (message.method === "turn/started") {
    if (turnId && !next.turns.some((entry) => entry.id === turnId)) {
      next.turns.push({ id: turnId, items: [], status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null });
    }
    next.status = { type: "active" };
    return next;
  }
  if (!turnId) return next;
  let turn = next.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    turn = { id: turnId, items: [], status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null };
    next.turns.push(turn);
  }
  const itemId = typeof params.itemId === "string" ? params.itemId : isRecord(params.item) && typeof params.item.id === "string" ? params.item.id : null;
  if ((message.method === "item/started" || message.method === "item/completed") && isRecord(params.item)) {
    const item = params.item as ThreadItem;
    const index = turn.items.findIndex((entry) => entry.id === item.id || (
      item.type === "userMessage" && userMessageText(entry) !== "" && userMessageText(entry) === userMessageText(item)
    ));
    if (index >= 0) turn.items[index] = item;
    else turn.items.push(item);
    return next;
  }
  if (!itemId || typeof params.delta !== "string") return next;
  let item = turn.items.find((entry) => entry.id === itemId);
  if (!item && message.method === "item/agentMessage/delta") {
    item = { id: itemId, type: "agentMessage", text: "", phase: null };
    turn.items.push(item);
  }
  if (!item) return next;
  if (message.method === "item/agentMessage/delta") item.text = String(item.text ?? "") + params.delta;
  if (message.method === "item/commandExecution/outputDelta") item.aggregatedOutput = String(item.aggregatedOutput ?? "") + params.delta;
  if (message.method === "item/reasoning/summaryTextDelta") {
    const index = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
    const summary = Array.isArray(item.summary) ? [...item.summary] : [];
    summary[index] = String(summary[index] ?? "") + params.delta;
    item.summary = summary;
  }
  if (message.method === "item/reasoning/textDelta") {
    const index = typeof params.contentIndex === "number" ? params.contentIndex : 0;
    const content = Array.isArray(item.content) ? [...item.content] : [];
    content[index] = String(content[index] ?? "") + params.delta;
    item.content = content;
  }
  return next;
}

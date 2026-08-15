import {
  Code2,
  CircleAlert,
  Folder,
  FolderPlus,
  Folders,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessagesSquare,
  Plus,
  Search,
  Server,
  ShieldAlert,
  User,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import webPackage from "../package.json";
import { ApiClient } from "./api";
import { EmptyConversation, IconButton, LoadingScreen, SidebarHeading, ThreadRow } from "./components";
import { ApprovalBar, Conversation } from "./conversation";
import { NewThreadDialog, WorkspaceDialog } from "./dialogs";
import {
  cloneThread,
  errorMessage,
  isRecord,
  mergeHistoricalTurns,
  mergeTurn,
  normalizePreferences,
  threadTitle,
  userMessageText,
} from "./lib";
import type { AuthState, PendingRequest, Preferences, Snapshot, Thread, ThreadItem, Turn, Workspace } from "./types";

const emptySnapshot: Snapshot = {
  connected: false,
  threads: [],
  workspaces: [],
  models: [],
  unreadThreadIds: [],
  pendingRequests: [],
};

const APP_VERSION = webPackage.version;
const SELECTION_KEYS = {
  workspace: "codex-ui.selected-workspace",
  thread: "codex-ui.selected-thread",
} as const;

const THREAD_CACHE_MAX = 25;
const READ_TIMEOUT_MS = 20_000;

type ThreadCacheEntry = {
  thread: Thread;
  preferences: Preferences;
  historyCursor: string | null;
  loadedAt: number;
};

const readSelection = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeSelection = (key: string, value: string | null): void => {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
};

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const api = useMemo(
    () =>
      new ApiClient(() => {
        setAuth({ authenticated: false });
      }),
    [],
  );

  // 引用稳定：避免每次活动续期触发 Dashboard 重建 WebSocket 连接
  const handleAuthChange = useCallback(
    (next: AuthState) => {
      api.setCsrfToken(next.csrfToken);
      setAuth(next);
    },
    [api],
  );

  useEffect(() => {
    void api
      .authSession()
      .then((session) => {
        api.setCsrfToken(session.csrfToken);
        setAuth(session);
      })
      .catch(() => setAuth({ authenticated: false }));
  }, [api]);

  if (!auth) return <LoadingScreen />;
  if (!auth.authenticated) {
    return (
      <LoginScreen
        onLogin={async (username, password) => {
          const session = await api.login(username, password);
          api.setCsrfToken(session.csrfToken);
          setAuth(session);
        }}
      />
    );
  }

  return (
    <Dashboard
      api={api}
      auth={auth}
      onAuthChange={handleAuthChange}
    />
  );
}

function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await onLogin(username, password);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-shell" aria-labelledby="login-title">
        <header className="login-brand">
          <div className="brand-mark"><Code2 size={23} /></div>
          <div>
            <div className="login-title-row"><h1 id="login-title">Codex UI</h1><span className="app-version">v{APP_VERSION}</span></div>
            <p>服务器会话控制台</p>
          </div>
        </header>
        <form className="login-form" onSubmit={submit}>
          <label>
            <span>用户名</span>
            <div className="input-with-icon">
              <User size={17} />
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus />
            </div>
          </label>
          <label>
            <span>密码</span>
            <div className="input-with-icon">
              <LockKeyhole size={17} />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </div>
          </label>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          <button className="primary-button login-button" type="submit" disabled={submitting || !username || !password}>
            {submitting ? <LoaderCircle className="spin" size={18} /> : <LockKeyhole size={17} />}
            登录
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard({ api, auth, onAuthChange }: { api: ApiClient; auth: AuthState; onAuthChange: (value: AuthState) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>(() => readSelection(SELECTION_KEYS.workspace) ?? "");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => readSelection(SELECTION_KEYS.thread));
  const [detail, setDetail] = useState<Thread | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>({ model: null, effort: null, fullAccess: false });
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<"workspaces" | "threads" | null>(null);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [approvalPanelOpen, setApprovalPanelOpen] = useState(false);
  const [search, setSearch] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
  const restoreThreadRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const autoHistoryRef = useRef(true);
  const detailRef = useRef<Thread | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef<Map<string, Promise<void>>>(new Map());
  const threadCacheRef = useRef<Map<string, ThreadCacheEntry>>(new Map());

  selectedRef.current = selectedThreadId;

  useEffect(() => {
    writeSelection(SELECTION_KEYS.workspace, selectedWorkspace || null);
  }, [selectedWorkspace]);

  useEffect(() => {
    writeSelection(SELECTION_KEYS.thread, selectedThreadId);
  }, [selectedThreadId]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useActivityRefresh(api, auth, onAuthChange);

  // 安全发送 viewing 消息：连接未就绪时跳过——open 事件会用 selectedRef 补发当前选择，
  // 对 CONNECTING/CLOSED 状态直接 send 会抛 InvalidStateError 并触发错误边界
  const sendViewing = useCallback((threadId: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "viewing", threadId }));
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
        const message = JSON.parse(event.data) as { type: string; payload?: unknown };
        if (message.type === "snapshot") updateSnapshot(message.payload as Snapshot);
        if (message.type === "connection") updateSnapshot({ connected: Boolean((message.payload as { connected?: boolean })?.connected) });
        if (message.type === "threads.changed") {
          const payload = message.payload as { threads?: Thread[]; thread?: Thread };
          if (payload.threads) updateSnapshot({ threads: payload.threads });
          if (payload.thread) {
            setSnapshot((current) => ({
              ...current,
              threads: [payload.thread!, ...current.threads.filter((thread) => thread.id !== payload.thread!.id)],
            }));
          }
        }
        if (message.type === "workspaces.changed") {
          updateSnapshot({ workspaces: (message.payload as { workspaces: Workspace[] }).workspaces });
        }
        if (message.type === "unread.changed") {
          updateSnapshot({ unreadThreadIds: (message.payload as { unreadThreadIds: string[] }).unreadThreadIds });
        }
        if (message.type === "requests.changed") {
          updateSnapshot({ pendingRequests: (message.payload as { pendingRequests: PendingRequest[] }).pendingRequests });
        }
        if (message.type === "thread.settings.changed") {
          const payload = message.payload as { threadId?: string; preferences?: Preferences };
          if (payload.threadId === selectedRef.current && payload.preferences) {
            setPreferences(payload.preferences);
          }
        }
        if (message.type === "codex.event") applyCodexEvent(message.payload as { method?: string; params?: Record<string, unknown> });
        if (message.type === "auth.expired") onAuthChange({ authenticated: false });
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
        loadedAt: Date.now(),
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
    const stale = cached !== undefined && cached.thread.updatedAt !== thread.updatedAt;

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
      const [value, unread] = await Promise.all([
        api.readThread(thread.id, { signal }),
        api.markRead(thread.id, { signal }),
      ]);
      if (detailRequestRef.current !== requestId) return;
      applyThreadLoad(thread.id, value);
      updateSnapshot({ unreadThreadIds: unread.unreadThreadIds });
      setDetailLoading(false);
    };

    const existing = inflightRef.current.get(thread.id);
    const promise = existing ?? load();
    inflightRef.current.set(thread.id, promise);
    void promise
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
        inflightRef.current.delete(thread.id);
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

  const workspaceThreads = useMemo(
    () =>
      snapshot.threads.filter(
        (thread) =>
          thread.cwd === selectedWorkspace &&
          (!search || threadTitle(thread).toLocaleLowerCase().includes(search.toLocaleLowerCase())),
      ),
    [search, selectedWorkspace, snapshot.threads],
  );

  const selectedThread = snapshot.threads.find((thread) => thread.id === selectedThreadId) ?? detail;
  const threadPending = snapshot.pendingRequests.filter((request) => request.params.threadId === selectedThread?.id);
  const otherPending = snapshot.pendingRequests.filter((request) => request.params.threadId !== selectedThread?.id);

  useEffect(() => {
    if (approvalPanelOpen && otherPending.length === 0) setApprovalPanelOpen(false);
  }, [approvalPanelOpen, otherPending.length]);

  const createThread = async (cwd: string, value: Preferences) => {
    const result = await api.createThread({ cwd, ...value });
    detailRequestRef.current += 1;
    abortRef.current?.abort();
    autoHistoryRef.current = false;
    threadCacheRef.current.set(result.thread.id, {
      thread: result.thread,
      preferences: result.preferences,
      historyCursor: null,
      loadedAt: Date.now(),
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
    setDrawer("threads");
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
      if (rolledBackId) SUPPRESSED_TURN_IDS.add(rolledBackId);
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
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-mark small"><Code2 size={19} /></div>
          <strong>Codex UI</strong><span className="app-version">v{APP_VERSION}</span>
        </div>
        <div className="mobile-nav-actions">
          <IconButton title="工作区" onClick={() => setDrawer(drawer === "workspaces" ? null : "workspaces")}><Folders size={19} /></IconButton>
          <IconButton title="会话" onClick={() => setDrawer(drawer === "threads" ? null : "threads")}><MessagesSquare size={19} /></IconButton>
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

      <aside className={`workspace-sidebar ${drawer === "workspaces" ? "drawer-open" : ""}`}>
        <SidebarHeading icon={<Folders size={17} />} title="工作区" onClose={() => setDrawer(null)} />
        <nav className="workspace-list" aria-label="工作区">
          {snapshot.workspaces.map((workspace) => (
            <button
              key={workspace.path}
              className={`workspace-row ${selectedWorkspace === workspace.path ? "selected" : ""}`}
              onClick={() => {
                setSelectedWorkspace(workspace.path);
                setDrawer("threads");
              }}
            >
              <Folder size={17} />
              <span className="workspace-copy"><strong>{workspace.name}</strong><small>{workspace.path}</small></span>
              <span className="count-badge">{workspace.threadCount}</span>
              {workspace.activeCount > 0 && <span className="active-pip" title="有任务进行中" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="sidebar-footer-copy"><Server size={15} />{snapshot.workspaces.length} 个工作区</span>
          <IconButton title="新增工作区" onClick={() => setWorkspaceDialogOpen(true)}><FolderPlus size={17} /></IconButton>
        </div>
      </aside>

      <aside className={`thread-sidebar ${drawer === "threads" ? "drawer-open" : ""}`}>
        <SidebarHeading icon={<MessagesSquare size={17} />} title="会话" onClose={() => setDrawer(null)} />
        <div className="thread-tools">
          <button className="new-thread-button" onClick={() => setNewThreadOpen(true)} disabled={!selectedWorkspace}>
            <Plus size={17} />新建会话
          </button>
          <label className="search-box">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话" />
          </label>
        </div>
        <nav className="thread-list" aria-label="会话">
          {workspaceThreads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              selected={thread.id === selectedThreadId}
              unread={snapshot.unreadThreadIds.includes(thread.id)}
              onSelect={() => void selectThread(thread)}
            />
          ))}
          {!loading && workspaceThreads.length === 0 && <div className="empty-sidebar">暂无会话</div>}
        </nav>
      </aside>

      {(drawer || newThreadOpen || workspaceDialogOpen || approvalPanelOpen) && (
        <button className="backdrop" aria-label="关闭" onClick={() => { setDrawer(null); setNewThreadOpen(false); setWorkspaceDialogOpen(false); setApprovalPanelOpen(false); }} />
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
          models={snapshot.models}
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

function useActivityRefresh(api: ApiClient, auth: AuthState, onAuthChange: (value: AuthState) => void) {
  useEffect(() => {
    let lastSent = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastSent < 60_000) return;
      lastSent = now;
      void api.activity().then(({ expiresAt }) => onAuthChange({ ...auth, expiresAt })).catch(() => undefined);
    };
    const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
    events.forEach((event) => window.addEventListener(event, onActivity, { passive: true }));
    const expiry = window.setInterval(() => {
      if (auth.expiresAt && Date.now() >= auth.expiresAt) onAuthChange({ authenticated: false });
    }, 30_000);
    return () => {
      events.forEach((event) => window.removeEventListener(event, onActivity));
      clearInterval(expiry);
    };
  }, [api, auth, onAuthChange]);
}

// 被回滚（修改重发）的轮次 id：codex 回滚后会补发这些轮次的完成事件，
// 忽略它们以防旧对话内容被重新追加到界面
const SUPPRESSED_TURN_IDS = new Set<string>();

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

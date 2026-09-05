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
import type { AuthState, Workspace } from "../shared/types";
import { Conversation } from "./conversation";
import type { OpencodeApiClient } from "./api";
import type { BusEvent, Message, MessageInfo, Part, PendingPermission, SessionState, Snapshot, Thread } from "./types";

const emptySnapshot: Snapshot = {
  connected: false,
  threads: [],
  workspaces: [],
  models: [],
  unreadThreadIds: [],
  pendingRequests: [],
};

const SELECTION_KEYS = {
  workspace: "codex-ui.opencode.selected-workspace",
  thread: "codex-ui.opencode.selected-thread",
  sidebar: "codex-ui.opencode.sidebar-collapsed",
} as const;

const THREAD_CACHE_MAX = 25;
const READ_TIMEOUT_MS = 20_000;

type DetailValue = { thread: Thread; state: SessionState; messages: Message[] };

export function OpencodeDashboard({
  api,
  auth,
  onAuthChange,
  switcher,
}: {
  api: OpencodeApiClient;
  auth: AuthState;
  onAuthChange: (value: AuthState) => void;
  switcher?: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>(() => readSelection(SELECTION_KEYS.workspace) ?? "");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => readSelection(SELECTION_KEYS.thread));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSelection(SELECTION_KEYS.sidebar) === "true");
  const [detail, setDetail] = useState<DetailValue | null>(null);
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
  const detailRef = useRef<DetailValue | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadCacheRef = useRef<Map<string, DetailValue>>(new Map());
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

  const sendViewing = useCallback((threadId: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "viewing", backend: "opencode", threadId }));
    } catch {
      // 发送失败可忽略：重连后的 open 事件会重新同步选择
    }
  }, []);

  const updateSnapshot = useCallback((incoming: Partial<Snapshot>) => {
    setSnapshot((current) => ({ ...current, ...incoming }));
  }, []);

  const commitDetail = useCallback((threadId: string, updater: (current: DetailValue) => DetailValue) => {
    const cached = threadCacheRef.current.get(threadId);
    if (!cached || cached.thread.id !== threadId) return;
    const next = updater(cached);
    threadCacheRef.current.set(threadId, next);
    if (selectedRef.current === threadId) {
      detailRef.current = next;
      setDetail(next);
    }
  }, []);

  const pruneThreadCache = useCallback(() => {
    const cache = threadCacheRef.current;
    while (cache.size > THREAD_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);

  const applyBusEvent = useCallback((event: BusEvent) => {
    const properties = isRecord(event.properties) ? event.properties : {};
    const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
    if (!sessionID || selectedRef.current !== sessionID) return;
    if (event.type === "session.status" || event.type === "session.idle" || event.type === "session.error") {
      const status = isRecord(properties.status) ? properties.status : null;
      const busy = event.type === "session.status" && status?.type === "busy";
      commitDetail(sessionID, (current) => ({
        ...current,
        thread: { ...current.thread, status: { type: busy ? "active" : "idle" } },
      }));
      return;
    }
    if (event.type === "message.updated" && isRecord(properties.info)) {
      const info = properties.info as unknown as MessageInfo;
      if (typeof info.id !== "string") return;
      commitDetail(sessionID, (current) => {
        const index = current.messages.findIndex((message) => message.info.id === info.id);
        if (index >= 0) {
          const messages = [...current.messages];
          const existing = messages[index]!;
          messages[index] = { info: { ...existing.info, ...info }, parts: existing.parts };
          return { ...current, messages };
        }
        return { ...current, messages: [...current.messages, { info, parts: [] }] };
      });
      return;
    }
    if (event.type === "message.removed") {
      const messageID = typeof properties.messageID === "string" ? properties.messageID : null;
      if (!messageID) return;
      commitDetail(sessionID, (current) => ({
        ...current,
        messages: current.messages.filter((message) => message.info.id !== messageID),
      }));
      return;
    }
    if (event.type === "message.part.delta") {
      const messageID = typeof properties.messageID === "string" ? properties.messageID : null;
      const partID = typeof properties.partID === "string" ? properties.partID : null;
      const field = typeof properties.field === "string" ? properties.field : "text";
      const delta = typeof properties.delta === "string" ? properties.delta : null;
      if (!messageID || !partID || delta === null) return;
      commitDetail(sessionID, (current) => {
        const index = current.messages.findIndex((message) => message.info.id === messageID);
        if (index < 0) return current;
        const messages = [...current.messages];
        const message = messages[index]!;
        const partIndex = message.parts.findIndex((entry) => entry.id === partID);
        if (partIndex < 0) return current;
        const parts = [...message.parts];
        const part = parts[partIndex]!;
        parts[partIndex] = { ...part, [field]: String(part[field] ?? "") + delta };
        messages[index] = { ...message, parts };
        return { ...current, messages };
      });
      return;
    }
    if (event.type === "message.part.updated" && isRecord(properties.part)) {
      const part = properties.part as unknown as Part;
      const messageID = typeof part.messageID === "string" ? part.messageID : null;
      if (!messageID || typeof part.id !== "string") return;
      commitDetail(sessionID, (current) => {
        const index = current.messages.findIndex((message) => message.info.id === messageID);
        if (index >= 0) {
          const messages = [...current.messages];
          const message = messages[index]!;
          const partIndex = message.parts.findIndex((entry) => entry.id === part.id);
          const parts = [...message.parts];
          if (partIndex >= 0) parts[partIndex] = { ...parts[partIndex], ...part };
          else parts.push(part);
          messages[index] = { ...message, parts };
          return { ...current, messages };
        }
        return {
          ...current,
          messages: [...current.messages, {
            info: { id: messageID, sessionID, role: "assistant", time: { created: Date.now() } },
            parts: [part],
          }],
        };
      });
    }
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
        if (message.backend !== "opencode") return;
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
          if (Array.isArray(pendingRequests)) updateSnapshot({ pendingRequests: pendingRequests as PendingPermission[] });
        }
        if (message.type === "opencode.event") applyBusEvent(message.payload as BusEvent);
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
  }, [applyBusEvent, onAuthChange, sendViewing, updateSnapshot]);

  const maybeMarkRead = useCallback((threadId: string) => {
    if (!snapshot.unreadThreadIds.includes(threadId)) return;
    void api
      .markRead(threadId)
      .then(({ unreadThreadIds }) => updateSnapshot({ unreadThreadIds }))
      .catch(() => undefined);
  }, [api, snapshot.unreadThreadIds, updateSnapshot]);

  const applyThreadLoad = useCallback((threadId: string, value: DetailValue) => {
    threadCacheRef.current.set(threadId, value);
    pruneThreadCache();
    if (selectedRef.current !== threadId) return;
    detailRef.current = value;
    setDetail(value);
  }, [pruneThreadCache]);

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
      setDetailLoading(false);
      detailRef.current = cached;
      setDetail(cached);
      maybeMarkRead(thread.id);
      return;
    }

    let timedOut = false;
    const timeoutTimer = window.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("加载超时", "TimeoutError"));
    }, READ_TIMEOUT_MS);
    const signal = controller.signal;
    setDetailLoading(cached === undefined);
    if (cached) {
      detailRef.current = cached;
      setDetail(cached);
    } else {
      detailRef.current = null;
      setDetail(null);
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
          setError("加载超时，请重新点击会话重试");
          return;
        }
        if (controller.signal.aborted) return;
        setError(errorMessage(reason));
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
      console.error("Failed to restore thread:", error);
    }
  }, [detail, detailLoading, selectedThreadId, snapshot.threads]);

  const filteredThreads = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return snapshot.threads.filter((thread) => {
      if (!query) return true;
      const title = thread.title?.trim() || thread.preview?.trim() || "未命名会话";
      return title.toLocaleLowerCase().includes(query);
    });
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

  const selectedThread = snapshot.threads.find((thread) => thread.id === selectedThreadId) ?? detail?.thread ?? null;
  const threadPending = snapshot.pendingRequests.filter((request) => request.sessionID === selectedThread?.id);
  const otherPending = snapshot.pendingRequests.filter((request) => request.sessionID !== selectedThread?.id);

  useEffect(() => {
    if (approvalPanelOpen && otherPending.length === 0) setApprovalPanelOpen(false);
  }, [approvalPanelOpen, otherPending.length]);

  const selectWorkspace = (workspacePath: string) => {
    setSelectedWorkspace(workspacePath);
    setDrawer("workspace");
    if (!selectedThread || selectedThread.cwd === workspacePath) return;
    detailRequestRef.current += 1;
    abortRef.current?.abort();
    setSelectedThreadId(null);
    detailRef.current = null;
    setDetail(null);
  };

  const createThread = async (cwd: string) => {
    const defaultModel = snapshot.models.find((model) => model.isDefault) ?? snapshot.models[0];
    const result = await api.createThread({ cwd, model: defaultModel?.id ?? null, fullAccess: false });
    detailRequestRef.current += 1;
    abortRef.current?.abort();
    threadCacheRef.current.set(result.thread.id, { thread: result.thread, state: result.state, messages: [] });
    pruneThreadCache();
    setSnapshot((current) => ({
      ...current,
      threads: [result.thread, ...current.threads.filter((thread) => thread.id !== result.thread.id)],
    }));
    setSelectedWorkspace(cwd);
    setSelectedThreadId(result.thread.id);
    detailRef.current = { thread: result.thread, state: result.state, messages: [] };
    setDetail(detailRef.current);
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
    threadCacheRef.current.delete(thread.id);
    setSnapshot((current) => ({
      ...current,
      threads: current.threads.filter((entry) => entry.id !== thread.id),
    }));
    if (selectedRef.current === thread.id) {
      detailRequestRef.current += 1;
      abortRef.current?.abort();
      setSelectedThreadId(null);
      detailRef.current = null;
      setDetail(null);
    }
    setDeleteCandidate(null);
  };

  const reloadDetail = useCallback(() => {
    const threadId = selectedRef.current;
    if (!threadId) return;
    threadCacheRef.current.delete(threadId);
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (thread) selectThread(thread);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.threads]);

  const markThreadActive = useCallback(() => {
    const threadId = selectedRef.current;
    if (!threadId) return;
    commitDetail(threadId, (current) => ({ ...current, thread: { ...current.thread, status: { type: "active" } } }));
    setSnapshot((current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === threadId ? { ...thread, status: { type: "active" } } : thread,
      ),
    }));
  }, [commitDetail]);

  const markThreadIdle = useCallback(() => {
    const threadId = selectedRef.current;
    if (!threadId) return;
    commitDetail(threadId, (current) => ({ ...current, thread: { ...current.thread, status: { type: "idle" } } }));
    setSnapshot((current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === threadId ? { ...thread, status: { type: "idle" } } : thread,
      ),
    }));
  }, [commitDetail]);

  const updateDetailState = (next: SessionState) => {
    const threadId = selectedRef.current;
    if (!threadId) return;
    commitDetail(threadId, (current) => ({ ...current, state: next }));
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      onAuthChange({ authenticated: false });
    }
  };

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} data-ui="opencode">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-mark small"><Code2 size={19} /></div>
          <strong>Opencode UI</strong><span className="app-version">v{webPackage.version}</span>
          {switcher}
        </div>
        <div className="mobile-nav-actions">
          <IconButton title="工作区与会话" onClick={() => setDrawer(drawer === "workspace" ? null : "workspace")}><Folders size={19} /></IconButton>
        </div>
        <div className="topbar-actions">
          <span className={`connection-pill ${snapshot.connected ? "online" : "offline"}`}>
            <span className="status-dot" />{snapshot.connected ? "opencode 在线" : "opencode 断开"}
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
                        title={thread.title?.trim().split("\n")[0]?.slice(0, 68) || "未命名会话"}
                        meta="opencode"
                        time={relativeTime(thread.updatedAt * 1000)}
                        active={thread.status.type === "active"}
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
            thread={detail?.thread ?? selectedThread}
            listThread={selectedThread}
            messages={detail?.messages ?? []}
            models={snapshot.models}
            state={detail?.state ?? { model: selectedThread.model, agent: selectedThread.agent, fullAccess: false }}
            pendingRequests={threadPending}
            loading={detailLoading}
            onStateChange={updateDetailState}
            onTurnStarted={markThreadActive}
            onTurnCancelled={markThreadIdle}
            onReload={reloadDetail}
            onNewThread={() => setNewThreadOpen(true)}
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
          title={deleteCandidate.title?.trim() || "未命名会话"}
          onClose={() => setDeleteCandidate(null)}
          onConfirm={() => confirmDeleteThread(deleteCandidate)}
        />
      )}

      {approvalPanelOpen && (
        <section className="dialog approval-dialog" role="dialog" aria-modal="true" aria-labelledby="oc-approval-dialog-title">
          <header><div><ShieldAlert size={18} /><h2 id="oc-approval-dialog-title">其他会话的待处理请求</h2></div><IconButton title="关闭" onClick={() => setApprovalPanelOpen(false)}><X size={18} /></IconButton></header>
          <div className="dialog-body">
            {otherPending.length === 0 ? (
              <p className="approval-empty">当前没有待处理请求。</p>
            ) : (
              <ul className="approval-other-list">
                {otherPending.map((request) => (
                  <li key={request.key}>
                    <strong>{request.permission}</strong>
                    <span>{request.patterns.join("、") || snapshot.threads.find((thread) => thread.id === request.sessionID)?.title || request.sessionID}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Code2,
  FileCode2,
  Folder,
  Folders,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MessageSquare,
  MessagesSquare,
  PanelLeft,
  Plus,
  Search,
  Send,
  Server,
  ShieldAlert,
  TerminalSquare,
  User,
  Wrench,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApiClient } from "./api";
import type {
  AuthState,
  Model,
  PendingRequest,
  Preferences,
  Snapshot,
  Thread,
  ThreadItem,
  Turn,
  Workspace,
} from "./types";

const emptySnapshot: Snapshot = {
  connected: false,
  threads: [],
  workspaces: [],
  models: [],
  unreadThreadIds: [],
  pendingRequests: [],
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
      onAuthChange={(next) => {
        api.setCsrfToken(next.csrfToken);
        setAuth(next);
      }}
    />
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-label="正在载入">
      <div className="brand-mark"><Code2 size={22} /></div>
      <LoaderCircle className="spin" size={20} />
    </main>
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
            <h1 id="login-title">Codex UI</h1>
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
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Thread | null>(null);
  const [preferences, setPreferences] = useState<Preferences>({ model: null, effort: null, fullAccess: false });
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<"workspaces" | "threads" | null>(null);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [search, setSearch] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef<string | null>(null);

  selectedRef.current = selectedThreadId;

  useActivityRefresh(api, auth, onAuthChange);

  const updateSnapshot = useCallback((incoming: Partial<Snapshot>) => {
    setSnapshot((current) => ({ ...current, ...incoming }));
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
    setDetail((current) => (current ? mutateThreadFromEvent(current, message) : current));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api
      .bootstrap()
      .then((value) => {
        if (!cancelled) {
          setSnapshot(value);
          setSelectedWorkspace((current) => current || value.workspaces[0]?.path || "");
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
        if (selectedRef.current) socket?.send(JSON.stringify({ type: "viewing", threadId: selectedRef.current }));
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
        if (message.type === "unread.changed") {
          updateSnapshot({ unreadThreadIds: (message.payload as { unreadThreadIds: string[] }).unreadThreadIds });
        }
        if (message.type === "requests.changed") {
          updateSnapshot({ pendingRequests: (message.payload as { pendingRequests: PendingRequest[] }).pendingRequests });
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
  }, [applyCodexEvent, onAuthChange, updateSnapshot]);

  const selectThread = async (thread: Thread) => {
    setSelectedThreadId(thread.id);
    setSelectedWorkspace(thread.cwd);
    setDrawer(null);
    setDetailLoading(true);
    setError("");
    socketRef.current?.send(JSON.stringify({ type: "viewing", threadId: thread.id }));
    try {
      const [value, unread] = await Promise.all([api.readThread(thread.id), api.markRead(thread.id)]);
      setDetail(value.thread);
      setPreferences(normalizePreferences(value.preferences, snapshot.models));
      updateSnapshot({ unreadThreadIds: unread.unreadThreadIds });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDetailLoading(false);
    }
  };

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

  const createThread = async (cwd: string, value: Preferences) => {
    const result = await api.createThread({ cwd, ...value });
    setSnapshot((current) => ({
      ...current,
      threads: [result.thread, ...current.threads.filter((thread) => thread.id !== result.thread.id)],
    }));
    setSelectedWorkspace(cwd);
    setSelectedThreadId(result.thread.id);
    setDetail(result.thread);
    setPreferences(result.preferences);
    setNewThreadOpen(false);
    socketRef.current?.send(JSON.stringify({ type: "viewing", threadId: result.thread.id }));
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
          <strong>Codex UI</strong>
        </div>
        <div className="mobile-nav-actions">
          <IconButton title="工作区" onClick={() => setDrawer(drawer === "workspaces" ? null : "workspaces")}><Folders size={19} /></IconButton>
          <IconButton title="会话" onClick={() => setDrawer(drawer === "threads" ? null : "threads")}><MessagesSquare size={19} /></IconButton>
        </div>
        <div className="topbar-actions">
          <span className={`connection-pill ${snapshot.connected ? "online" : "offline"}`}>
            <span className="status-dot" />{snapshot.connected ? "Codex 在线" : "Codex 断开"}
          </span>
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
        <div className="sidebar-footer"><Server size={15} /><span>{snapshot.workspaces.length} 个工作区</span></div>
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

      {(drawer || newThreadOpen) && <button className="backdrop" aria-label="关闭" onClick={() => { setDrawer(null); setNewThreadOpen(false); }} />}

      <section className="conversation-pane">
        {error && <div className="global-error"><CircleAlert size={17} />{error}<button onClick={() => setError("")} aria-label="关闭"><X size={16} /></button></div>}
        {!selectedThread ? (
          <EmptyConversation onCreate={() => setNewThreadOpen(true)} disabled={!selectedWorkspace} />
        ) : (
          <Conversation
            api={api}
            thread={detail ?? selectedThread}
            listThread={selectedThread}
            models={snapshot.models}
            preferences={preferences}
            pendingRequests={snapshot.pendingRequests.filter((request) => request.params.threadId === selectedThread.id)}
            loading={detailLoading}
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

function SidebarHeading({ icon, title, onClose }: { icon: ReactNode; title: string; onClose: () => void }) {
  return (
    <header className="sidebar-heading">
      <span>{icon}<strong>{title}</strong></span>
      <button className="drawer-close" onClick={onClose} title="关闭"><X size={18} /></button>
    </header>
  );
}

function ThreadRow({ thread, selected, unread, onSelect }: { thread: Thread; selected: boolean; unread: boolean; onSelect: () => void }) {
  return (
    <button className={`thread-row ${selected ? "selected" : ""} ${unread ? "unread" : ""}`} onClick={onSelect}>
      <span className="thread-title-line">
        <strong>{threadTitle(thread)}</strong>
        {thread.status.type === "active" && <LoaderCircle className="spin active-icon" size={15} />}
        {thread.archived && <Archive size={14} />}
        {unread && <span className="unread-dot" title="任务已完成" />}
      </span>
      <span className="thread-meta">
        <span>{sourceLabel(thread.source)}</span>
        <time>{relativeTime((thread.recencyAt ?? thread.updatedAt) * 1000)}</time>
      </span>
    </button>
  );
}

function EmptyConversation({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  return (
    <div className="empty-conversation">
      <div className="empty-icon"><MessageSquare size={24} /></div>
      <h2>选择一个会话</h2>
      <p>历史记录与正在进行的任务会显示在这里。</p>
      <button className="primary-button" onClick={onCreate} disabled={disabled}><Plus size={17} />新建会话</button>
    </div>
  );
}

function Conversation({
  api,
  thread,
  listThread,
  models,
  preferences,
  pendingRequests,
  loading,
  onPreferencesChange,
  onError,
  onRequestsChange,
}: {
  api: ApiClient;
  thread: Thread;
  listThread: Thread;
  models: Model[];
  preferences: Preferences;
  pendingRequests: PendingRequest[];
  loading: boolean;
  onPreferencesChange: (value: Preferences) => void;
  onError: (value: string) => void;
  onRequestsChange: (value: PendingRequest[]) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const active = listThread.status.type === "active" || thread.status.type === "active";
  const selectedModel = modelFor(models, preferences.model);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.turns]);

  useEffect(() => {
    if (selectedModel && !efforts.some((entry) => entry.reasoningEffort === preferences.effort)) {
      onPreferencesChange({ ...preferences, model: selectedModel.model, effort: selectedModel.defaultReasoningEffort });
    }
  }, [efforts, onPreferencesChange, preferences, selectedModel]);

  const send = async () => {
    if (!text.trim() || active || sending) return;
    setSending(true);
    onError("");
    try {
      await api.startTurn(thread.id, { text: text.trim(), ...preferences });
      setText("");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="conversation-layout">
      <header className="conversation-header">
        <div className="conversation-title">
          <div className="conversation-state-icon">{active ? <LoaderCircle className="spin" size={18} /> : <MessageSquare size={18} />}</div>
          <div><h1>{threadTitle(listThread)}</h1><p>{thread.cwd}</p></div>
        </div>
        <div className="session-controls">
          <label title="选择模型">
            <span>模型</span>
            <select
              value={preferences.model ?? selectedModel?.model ?? ""}
              onChange={(event) => {
                const model = modelFor(models, event.target.value);
                onPreferencesChange({ ...preferences, model: event.target.value, effort: model?.defaultReasoningEffort ?? null });
              }}
            >
              {models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
            </select>
            <ChevronDown size={14} />
          </label>
          <label title="选择思考强度">
            <span>思考</span>
            <select value={preferences.effort ?? ""} onChange={(event) => onPreferencesChange({ ...preferences, effort: event.target.value })}>
              {efforts.map((entry) => <option key={entry.reasoningEffort} value={entry.reasoningEffort}>{effortLabel(entry.reasoningEffort)}</option>)}
            </select>
            <ChevronDown size={14} />
          </label>
          <label className={`access-toggle ${preferences.fullAccess ? "enabled" : ""}`} title="允许 Codex 不受沙箱限制地执行任务">
            <ShieldAlert size={16} />
            <span>完全访问</span>
            <input
              type="checkbox"
              checked={preferences.fullAccess}
              onChange={(event) => onPreferencesChange({ ...preferences, fullAccess: event.target.checked })}
            />
            <i aria-hidden="true" />
          </label>
        </div>
      </header>

      <div className="conversation-scroll">
        {loading ? (
          <div className="history-loading"><LoaderCircle className="spin" size={20} />加载历史记录</div>
        ) : (
          <div className="history-stream">
            {thread.turns.map((turn) => <TurnView key={turn.id} turn={turn} />)}
            {thread.turns.length === 0 && <div className="new-thread-state"><Bot size={25} /><h2>新会话</h2><p>在下方输入第一项需求。</p></div>}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {pendingRequests.length > 0 && (
        <ApprovalBar api={api} requests={pendingRequests} onError={onError} onRequestsChange={onRequestsChange} />
      )}

      <footer className="composer-shell">
        <div className="composer">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={active ? "任务进行中" : "发送新的需求"}
            disabled={active}
            rows={2}
          />
          <button className="send-button" onClick={() => void send()} disabled={active || sending || !text.trim()} title="发送">
            {sending ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}
          </button>
        </div>
      </footer>
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <section className="turn-block" data-status={turn.status}>
      {turn.items.map((item, index) => <ItemView key={item.id ?? `${turn.id}-${index}`} item={item} />)}
      {turn.status === "inProgress" && <div className="working-indicator"><LoaderCircle className="spin" size={15} />Codex 正在处理</div>}
      {turn.error !== null && turn.error !== undefined && <div className="turn-error"><CircleAlert size={16} />{stringify(turn.error)}</div>}
    </section>
  );
}

function ItemView({ item }: { item: ThreadItem }) {
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : "")).filter(Boolean).join("\n");
    return <article className="message user-message"><div className="message-label"><User size={14} />你</div><div className="message-body">{text}</div></article>;
  }
  if (item.type === "agentMessage") {
    return <article className="message agent-message"><div className="message-label"><Bot size={15} />Codex</div><div className="message-body">{String(item.text ?? "")}</div></article>;
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
    const content = Array.isArray(item.content) ? item.content.join("\n") : "";
    return <details className="reasoning-item"><summary><CircleDot size={15} />思考过程</summary><pre>{summary || content || "正在思考..."}</pre></details>;
  }
  if (item.type === "plan") {
    return <article className="tool-item"><div className="tool-heading"><CircleCheck size={15} />计划</div><pre>{String(item.text ?? "")}</pre></article>;
  }
  if (item.type === "commandExecution") {
    return (
      <article className="tool-item command-item">
        <div className="tool-heading"><TerminalSquare size={15} />命令<span className={`tool-status ${String(item.status)}`}>{toolStatus(item.status)}</span></div>
        <code>{String(item.command ?? "")}</code>
        {item.aggregatedOutput ? <pre>{String(item.aggregatedOutput)}</pre> : null}
      </article>
    );
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return (
      <article className="tool-item file-item">
        <div className="tool-heading"><FileCode2 size={15} />文件修改<span className={`tool-status ${String(item.status)}`}>{toolStatus(item.status)}</span></div>
        <ul>{changes.map((change, index) => <li key={index}>{changePath(change)}</li>)}</ul>
      </article>
    );
  }
  if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch"].includes(item.type)) {
    return (
      <details className="tool-item compact-tool">
        <summary><Wrench size={15} />{toolName(item)}<span className={`tool-status ${String(item.status ?? "")}`}>{toolStatus(item.status)}</span></summary>
        <pre>{stringify(item)}</pre>
      </details>
    );
  }
  if (item.type === "contextCompaction") {
    return <div className="system-note"><Check size={14} />上下文已整理</div>;
  }
  return null;
}

function ApprovalBar({ api, requests, onError, onRequestsChange }: { api: ApiClient; requests: PendingRequest[]; onError: (value: string) => void; onRequestsChange: (value: PendingRequest[]) => void }) {
  const request = requests[0]!;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const command = typeof request.params.command === "string" ? request.params.command : null;
  const reason = typeof request.params.reason === "string" ? request.params.reason : null;
  const questions = Array.isArray(request.params.questions)
    ? request.params.questions.filter(isRecord)
    : [];
  const isQuestion = request.method === "item/tool/requestUserInput";
  const respond = async (decision: "accept" | "decline") => {
    try {
      const body = isQuestion
        ? {
            answers: Object.fromEntries(
              questions.map((question) => [String(question.id), { answers: [answers[String(question.id)] ?? ""] }]),
            ),
          }
        : { decision };
      const result = (await api.respondToRequest(request.key, body)) as { pendingRequests?: PendingRequest[] };
      onRequestsChange(result.pendingRequests ?? requests.filter((entry) => entry.key !== request.key));
    } catch (error) {
      onError(errorMessage(error));
    }
  };
  return (
    <section className={`approval-bar ${isQuestion ? "question-bar" : ""}`}>
      <ShieldAlert size={18} />
      <div className="approval-content">
        <strong>{approvalTitle(request.method)}</strong>
        {isQuestion ? (
          <div className="question-fields">
            {questions.map((question) => {
              const id = String(question.id);
              const options = Array.isArray(question.options) ? question.options.filter(isRecord) : [];
              return (
                <label key={id}>
                  <span>{String(question.question ?? question.header ?? "请输入回答")}</span>
                  {options.length ? (
                    <select value={answers[id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))}>
                      <option value="">请选择</option>
                      {options.map((option) => <option key={String(option.label)} value={String(option.label)}>{String(option.label)}</option>)}
                    </select>
                  ) : (
                    <input
                      type={question.isSecret ? "password" : "text"}
                      value={answers[id] ?? ""}
                      onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))}
                    />
                  )}
                </label>
              );
            })}
          </div>
        ) : <p>{reason || command || "Codex 需要确认后继续"}</p>}
      </div>
      {requests.length > 1 && <span className="count-badge">{requests.length}</span>}
      {!isQuestion && <button className="secondary-button" onClick={() => void respond("decline")}>拒绝</button>}
      <button
        className="primary-button compact"
        onClick={() => void respond("accept")}
        disabled={isQuestion && questions.some((question) => !answers[String(question.id)]?.trim())}
      ><Check size={16} />{isQuestion ? "提交" : "允许"}</button>
    </section>
  );
}

function NewThreadDialog({ workspaces, initialWorkspace, models, onClose, onCreate }: {
  workspaces: Workspace[];
  initialWorkspace: string;
  models: Model[];
  onClose: () => void;
  onCreate: (cwd: string, value: Preferences) => Promise<void>;
}) {
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const [cwd, setCwd] = useState(initialWorkspace || workspaces[0]?.path || "");
  const [model, setModel] = useState(defaultModel?.model ?? "");
  const [effort, setEffort] = useState(defaultModel?.defaultReasoningEffort ?? "medium");
  const [fullAccess, setFullAccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const selectedModel = modelFor(models, model);

  const create = async () => {
    setSubmitting(true);
    setError("");
    try {
      await onCreate(cwd, { model, effort, fullAccess });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-thread-title">
      <header><div><Plus size={18} /><h2 id="new-thread-title">新建会话</h2></div><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="dialog-body">
        <label><span>工作区</span><select value={cwd} onChange={(event) => setCwd(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.path} value={workspace.path}>{workspace.name} - {workspace.path}</option>)}</select></label>
        <div className="dialog-grid">
          <label><span>模型</span><select value={model} onChange={(event) => { const next = modelFor(models, event.target.value); setModel(event.target.value); setEffort(next?.defaultReasoningEffort ?? "medium"); }}>{models.map((entry) => <option key={entry.id} value={entry.model}>{entry.displayName}</option>)}</select></label>
          <label><span>思考强度</span><select value={effort} onChange={(event) => setEffort(event.target.value)}>{selectedModel?.supportedReasoningEfforts.map((entry) => <option key={entry.reasoningEffort} value={entry.reasoningEffort}>{effortLabel(entry.reasoningEffort)}</option>)}</select></label>
        </div>
        <label className="dialog-toggle"><div><ShieldAlert size={17} /><span><strong>完全访问权限</strong><small>关闭沙箱与命令审批</small></span></div><input type="checkbox" checked={fullAccess} onChange={(event) => setFullAccess(event.target.checked)} /><i /></label>
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      </div>
      <footer><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => void create()} disabled={submitting || !cwd || !model}>{submitting ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}创建</button></footer>
    </section>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return <button className="icon-button" title={title} aria-label={title} onClick={onClick}>{children}</button>;
}

function mutateThreadFromEvent(thread: Thread, message: { method?: string; params?: Record<string, unknown> }): Thread {
  const next = structuredClone(thread);
  const params = message.params ?? {};
  const turnId = typeof params.turnId === "string" ? params.turnId : isRecord(params.turn) && typeof params.turn.id === "string" ? params.turn.id : null;
  if (message.method === "turn/started" && isRecord(params.turn)) {
    const turn = params.turn as Turn;
    if (!next.turns.some((entry) => entry.id === turn.id)) next.turns.push(turn);
    next.status = { type: "active" };
    return next;
  }
  if (message.method === "turn/completed" && isRecord(params.turn)) {
    const turn = params.turn as Turn;
    const index = next.turns.findIndex((entry) => entry.id === turn.id);
    if (index >= 0) next.turns[index] = turn;
    else next.turns.push(turn);
    next.status = { type: "idle" };
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
    const index = turn.items.findIndex((entry) => entry.id === item.id);
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

const modelFor = (models: Model[], value: string | null) => models.find((model) => model.model === value || model.id === value) ?? models.find((model) => model.isDefault) ?? models[0];
const normalizePreferences = (value: Preferences, models: Model[]): Preferences => {
  const model = modelFor(models, value.model);
  return { model: value.model ?? model?.model ?? null, effort: value.effort ?? model?.defaultReasoningEffort ?? null, fullAccess: value.fullAccess };
};

const threadTitle = (thread: Thread): string => thread.name?.trim() || thread.preview?.trim().split("\n")[0]?.slice(0, 68) || "未命名会话";
const sourceLabel = (source: unknown): string => {
  const raw = typeof source === "string" ? source : isRecord(source) ? Object.keys(source)[0] ?? "Codex" : "Codex";
  const labels: Record<string, string> = { cli: "CLI", vscode: "VS Code", exec: "Exec", appServer: "Web", subAgent: "子代理" };
  return labels[raw] ?? raw;
};
const relativeTime = (timestamp: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86400)} 天`;
};
const effortLabel = (value: string): string => ({ none: "无", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" })[value] ?? value;
const toolStatus = (value: unknown): string => ({ inProgress: "进行中", completed: "完成", failed: "失败", declined: "已拒绝" })[String(value)] ?? "";
const toolName = (item: ThreadItem): string => String(item.tool ?? (item.type === "webSearch" ? "网页搜索" : "工具调用"));
const changePath = (change: unknown): string => {
  if (!isRecord(change)) return stringify(change);
  return String(change.path ?? change.filePath ?? Object.keys(change)[0] ?? "文件");
};
const approvalTitle = (method: string): string => method.includes("requestUserInput") ? "Codex 需要你的回答" : method.includes("fileChange") ? "确认文件修改" : method.includes("commandExecution") ? "确认执行命令" : "Codex 等待确认";
const errorMessage = (value: unknown): string => value instanceof Error ? value.message : "操作失败";
const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

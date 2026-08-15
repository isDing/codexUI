import {
  Bot,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronsUp,
  CircleAlert,
  CircleCheck,
  CircleDot,
  FileCode2,
  LoaderCircle,
  MessageSquare,
  Send,
  ShieldAlert,
  TerminalSquare,
  User,
  Wrench,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ApiClient } from "./api";
import {
  approvalTitle,
  changePath,
  effortLabel,
  ensureUserMessage,
  errorMessage,
  isProcessItem,
  isRecord,
  modelFor,
  stringify,
  toolName,
  toolStatus,
  userMessageItem,
} from "./lib";
import type { Model, PendingRequest, Preferences, Thread, ThreadItem, Turn } from "./types";

export function Conversation({
  api,
  thread,
  listThread,
  models,
  preferences,
  pendingRequests,
  loading,
  loadingOlder,
  hasOlder,
  onLoadOlder,
  onTurnStarted,
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
  loadingOlder: boolean;
  hasOlder: boolean;
  onLoadOlder: () => void;
  onTurnStarted: (threadId: string, turn: Turn) => void;
  onPreferencesChange: (value: Preferences) => void;
  onError: (value: string) => void;
  onRequestsChange: (value: PendingRequest[]) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const scrollStateRef = useRef({ threadId: "", firstTurnId: "", lastTurnId: "", height: 0 });
  const active = listThread.status.type === "active" || thread.status.type === "active";
  const previousActiveRef = useRef(active);
  const [processesOpen, setProcessesOpen] = useState(active);
  const [isMobileLayout, setIsMobileLayout] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 820px)").matches,
  );
  const selectedModel = modelFor(models, preferences.model);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const onChange = () => setIsMobileLayout(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // 输入框高度随内容自适应：默认单行，最多 150px
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 150)}px`;
  }, [text, active]);

  useEffect(() => {
    if (active === previousActiveRef.current) return;
    previousActiveRef.current = active;
    setProcessesOpen(active);
  }, [active]);

  useLayoutEffect(() => {
    const details = scrollRef.current?.querySelectorAll<HTMLDetailsElement>(
      "details.reasoning-item, details.commentary-message, details.tool-item",
    );
    details?.forEach((detail) => {
      // 纯过程内容的轮次始终展开，折叠开关只影响混排轮次
      if (detail.hasAttribute("data-always-open")) return;
      detail.open = processesOpen;
    });
  }, [processesOpen, thread.turns]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const previous = scrollStateRef.current;
    const firstTurnId = thread.turns[0]?.id ?? "";
    const lastTurnId = thread.turns[thread.turns.length - 1]?.id ?? "";
    const prepended =
      previous.threadId === thread.id &&
      Boolean(previous.firstTurnId) &&
      previous.firstTurnId !== firstTurnId &&
      previous.lastTurnId === lastTurnId;

    if (prepended) {
      scroller.scrollTop += scroller.scrollHeight - previous.height;
    } else if (previous.threadId !== thread.id || atBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
    atBottomRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    scrollStateRef.current = { threadId: thread.id, firstTurnId, lastTurnId, height: scroller.scrollHeight };
  }, [loadingOlder, thread.id, thread.turns]);

  useEffect(() => {
    if (selectedModel && !efforts.some((entry) => entry.reasoningEffort === preferences.effort)) {
      onPreferencesChange({ ...preferences, model: selectedModel.model, effort: selectedModel.defaultReasoningEffort });
    }
  }, [efforts, onPreferencesChange, preferences, selectedModel]);

  const send = async () => {
    if (!text.trim() || active || sending) return;
    setSending(true);
    onError("");
    const requestText = text.trim();
    try {
      const result = await api.startTurn(thread.id, { text: requestText, ...preferences });
      const turn = result.turn
        ? ensureUserMessage(result.turn, requestText)
        : {
            id: `local-${Date.now()}`,
            items: [userMessageItem(requestText)],
            status: "inProgress",
            error: null,
            startedAt: Math.floor(Date.now() / 1000),
            completedAt: null,
            durationMs: null,
          };
      onTurnStarted(thread.id, turn);
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
          <div><h1>{thread.name?.trim() || thread.preview?.trim().split("\n")[0]?.slice(0, 68) || "未命名会话"}</h1><p>{thread.cwd}</p></div>
        </div>
        <div className="session-controls">
          <button
            type="button"
            className="process-toggle"
            aria-label={processesOpen ? "收起过程" : "展开过程"}
            aria-pressed={processesOpen}
            title={processesOpen ? "收起全部思考、过程消息和工具调用" : "展开全部思考、过程消息和工具调用"}
            onClick={() => setProcessesOpen((current) => !current)}
          >
            {processesOpen ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
            <span>{processesOpen ? "收起过程" : "展开过程"}</span>
          </button>
          <label title="选择模型">
            <span>模型</span>
            <select
              value={preferences.model ?? selectedModel?.model ?? ""}
              onChange={(event) => {
                const model = modelFor(models, event.target.value);
                onPreferencesChange({ ...preferences, model: event.target.value, effort: model?.defaultReasoningEffort ?? null });
              }}
            >
              {models.map((model) => <option key={model.id} value={model.model} title={model.description}>{model.displayName}</option>)}
            </select>
            <ChevronDown size={14} />
          </label>
          <label title="选择思考强度">
            <span>思考</span>
            <select value={preferences.effort ?? ""} onChange={(event) => onPreferencesChange({ ...preferences, effort: event.target.value })}>
              {efforts.map((entry) => <option key={entry.reasoningEffort} value={entry.reasoningEffort} title={entry.description}>{effortLabel(entry.reasoningEffort)}</option>)}
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

      <div
        className="conversation-scroll"
        ref={scrollRef}
        data-processes-open={processesOpen ? "true" : "false"}
        onScroll={(event) => {
          const scroller = event.currentTarget;
          atBottomRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
        }}
      >
        {loading ? (
          <div className="history-loading"><LoaderCircle className="spin" size={20} />加载历史记录</div>
        ) : (
          <div className="history-stream">
            {loadingOlder && <div className="history-progress" role="status"><LoaderCircle className="spin" size={15} />正在加载较早记录</div>}
            {!loadingOlder && hasOlder && (
              <button className="load-older-button" onClick={onLoadOlder} disabled={active}>
                <ChevronsUp size={14} />加载更早的记录
              </button>
            )}
            {thread.turns.map((turn) => <TurnView key={turn.id} turn={turn} processesOpen={processesOpen} />)}
            {thread.turns.length === 0 && <div className="new-thread-state"><Bot size={25} /><h2>新会话</h2><p>在下方输入第一项需求。</p></div>}
          </div>
        )}
      </div>

      {pendingRequests.length > 0 && (
        <ApprovalBar api={api} requests={pendingRequests} onError={onError} onRequestsChange={onRequestsChange} />
      )}

      <footer className="composer-shell">
        <div className="composer">
          <textarea
            ref={composerRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // 中文输入法选词期间的回车不触发发送
              if (event.nativeEvent.isComposing) return;
              if (isMobileLayout) {
                // 移动端：回车换行（默认行为），发送按钮负责发送
                return;
              }
              // 电脑端：Enter 发送，Shift+Enter 走默认换行
              if (!event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={active ? "任务进行中" : isMobileLayout ? "输入需求，回车换行" : "发送新的需求"}
            disabled={active}
            rows={1}
          />
          <button className="send-button" onClick={() => void send()} disabled={active || sending || !text.trim()} title="发送">
            {sending ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}
          </button>
        </div>
      </footer>
    </div>
  );
}

function TurnView({ turn, processesOpen }: { turn: Turn; processesOpen: boolean }) {
  const items = turn.items;
  // 整轮都是过程内容时，折叠会导致一片空白——这类轮次始终展开展示
  const forceShow = items.length > 0 && !items.some((item) => !isProcessItem(item));
  return (
    <section className="turn-block" data-status={turn.status}>
      {items.length === 0 && (
        <div className="system-note interrupted-note"><CircleAlert size={14} />该轮次没有可显示的内容（可能已被中断）</div>
      )}
      {items.length > 0 && turn.status === "interrupted" && (
        <div className="system-note interrupted-note"><CircleAlert size={14} />该轮次已中断，以下为中断前的过程内容</div>
      )}
      {items.map((item, index) => (
        processesOpen || forceShow || !isProcessItem(item)
          ? <ItemView key={item.id ?? `${turn.id}-${index}`} item={item} alwaysOpen={forceShow} />
          : null
      ))}
      {turn.status === "inProgress" && <div className="working-indicator"><LoaderCircle className="spin" size={15} />Codex 正在处理</div>}
      {turn.error !== null && turn.error !== undefined && <div className="turn-error"><CircleAlert size={16} />{stringify(turn.error)}</div>}
    </section>
  );
}

function ItemView({ item, alwaysOpen = false }: { item: ThreadItem; alwaysOpen?: boolean }) {
  const detailProps = alwaysOpen ? { open: true, "data-always-open": "" } : {};
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : "")).filter(Boolean).join("\n");
    return <article className="message user-message"><div className="message-label"><User size={14} />你</div><div className="message-body">{text}</div></article>;
  }
  if (item.type === "agentMessage") {
    const phase = typeof item.phase === "string" ? item.phase : "final_answer";
    const content = String(item.text ?? "");
    if (phase === "commentary") {
      return (
        <details className="message commentary-message" {...detailProps}>
          <summary className="message-label"><Bot size={15} />过程消息</summary>
          <div className="message-body markdown-body"><MarkdownContent content={content} /></div>
        </details>
      );
    }
    return <article className="message agent-message"><div className="message-label"><Bot size={15} />Codex</div><div className="message-body markdown-body"><MarkdownContent content={content} /></div></article>;
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
    const content = Array.isArray(item.content) ? item.content.join("\n") : "";
    return <details className="reasoning-item" {...detailProps}><summary><CircleDot size={15} />思考过程</summary><pre>{summary || content || "正在思考..."}</pre></details>;
  }
  if (item.type === "plan") {
    return (
      <details className="tool-item compact-tool" {...detailProps}>
        <summary><CircleCheck size={15} />计划<span className={`tool-status ${String(item.status ?? "")}`}>{toolStatus(item.status)}</span></summary>
        <pre>{String(item.text ?? "")}</pre>
      </details>
    );
  }
  if (item.type === "commandExecution") {
    return (
      <details className="tool-item command-item compact-tool" {...detailProps}>
        <summary><TerminalSquare size={15} />命令<span className={`tool-status ${String(item.status)}`}>{toolStatus(item.status)}</span></summary>
        <code>{String(item.command ?? "")}</code>
        {item.aggregatedOutput ? <pre>{String(item.aggregatedOutput)}</pre> : null}
      </details>
    );
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return (
      <details className="tool-item file-item compact-tool" {...detailProps}>
        <summary><FileCode2 size={15} />文件修改<span className={`tool-status ${String(item.status)}`}>{toolStatus(item.status)}</span></summary>
        <ul>{changes.map((change, index) => <li key={index}>{changePath(change)}</li>)}</ul>
      </details>
    );
  }
  if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch"].includes(item.type)) {
    return (
      <details className="tool-item compact-tool" {...detailProps}>
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

export function ApprovalBar({ api, requests, onError, onRequestsChange }: {
  api: ApiClient;
  requests: PendingRequest[];
  onError: (value: string) => void;
  onRequestsChange: (value: PendingRequest[]) => void;
}) {
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

function MarkdownContent({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}

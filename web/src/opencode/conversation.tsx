import {
  Bot,
  Check,
  CircleAlert,
  CircleDot,
  FileCode2,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Send,
  ShieldAlert,
  Slash,
  Square,
  TerminalSquare,
  User,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage, isRecord, stringify } from "../shared/lib";
import type { OpencodeApiClient } from "./api";
import { filterSlashCommands, matchSlashCommand, parseSlash, type SlashCommand } from "./slash";
import type { Message, Model, Part, PendingPermission, SessionState, Thread } from "./types";

type Block = { id: string; user?: Message; assistants: Message[] };

export const groupMessages = (messages: Message[]): Block[] => {
  const blocks: Block[] = [];
  for (const message of messages) {
    if (message.info.role === "user" || blocks.length === 0) {
      blocks.push({ id: message.info.id, user: message.info.role === "user" ? message : undefined, assistants: message.info.role === "assistant" ? [message] : [] });
      continue;
    }
    blocks[blocks.length - 1]!.assistants.push(message);
  }
  return blocks;
};

const partText = (part: Part): string => (typeof part.text === "string" ? part.text : "");

const toolState = (part: Part): Record<string, unknown> =>
  isRecord(part.state) ? part.state : {};

export function Conversation({
  api,
  thread,
  listThread,
  messages,
  models,
  state,
  pendingRequests,
  loading,
  onStateChange,
  onTurnStarted,
  onTurnCancelled,
  onReload,
  onNewThread,
  onError,
  onRequestsChange,
}: {
  api: OpencodeApiClient;
  thread: Thread;
  listThread: Thread;
  messages: Message[];
  models: Model[];
  state: SessionState;
  pendingRequests: PendingPermission[];
  loading: boolean;
  onStateChange: (value: SessionState) => void;
  onTurnStarted: () => void;
  onTurnCancelled: () => void;
  onReload: () => void;
  onNewThread: () => void;
  onError: (value: string) => void;
  onRequestsChange: (value: PendingPermission[]) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editing, setEditing] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const scrollStateRef = useRef({ threadId: "", firstBlockId: "", lastBlockId: "", height: 0 });
  const active = listThread.status.type === "active" || thread.status.type === "active";
  const [isMobileLayout, setIsMobileLayout] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 820px)").matches,
  );
  const slashParsed = parseSlash(text);
  const slashMatches = filterSlashCommands(slashParsed && !slashParsed.escaped ? slashParsed.command : "");

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const onChange = () => setIsMobileLayout(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (slashParsed && !slashParsed.escaped) {
      if (!slashDismissed) {
        setSlashMenuOpen(true);
        setSlashHighlight(0);
      }
    } else {
      setSlashMenuOpen(false);
      setSlashDismissed(false);
      setSlashHighlight(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 150)}px`;
  }, [text, active]);

  const blocks = groupMessages(messages);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const previous = scrollStateRef.current;
    const firstBlockId = blocks[0]?.id ?? "";
    const lastBlockId = blocks[blocks.length - 1]?.id ?? "";
    const prepended =
      previous.threadId === thread.id &&
      Boolean(previous.firstBlockId) &&
      previous.firstBlockId !== firstBlockId &&
      previous.lastBlockId === lastBlockId;

    if (prepended) {
      scroller.scrollTop += scroller.scrollHeight - previous.height;
    } else if (previous.threadId !== thread.id || atBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
    atBottomRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    scrollStateRef.current = { threadId: thread.id, firstBlockId, lastBlockId, height: scroller.scrollHeight };
  }, [blocks, thread.id]);

  const send = async (override?: string) => {
    const requestText = (override ?? text).trim();
    if (!requestText || active || sending) {
      if (active && requestText) onError("任务进行中：可等待完成或点击停止按钮");
      return;
    }
    setSending(true);
    onError("");
    try {
      await api.startTurn(thread.id, { text: requestText, model: state.model, agent: state.agent, fullAccess: state.fullAccess });
      onTurnStarted();
      setText("");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setSending(false);
    }
  };

  const retry = async () => {
    const requestText = text.trim();
    if (!requestText || active || sending) return;
    setSending(true);
    onError("");
    try {
      await api.retryTurn(thread.id, { text: requestText, model: state.model, agent: state.agent, fullAccess: state.fullAccess });
      onTurnStarted();
      onReload();
      setText("");
      setEditing(false);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setSending(false);
    }
  };

  const runSlashCommand = async (command: SlashCommand, args: string) => {
    onError("");
    if (command.kind === "rpc") {
      try {
        await api.runCommand(thread.id, command.name, args || undefined);
      } catch (reason) {
        onError(errorMessage(reason));
      }
      return;
    }
    switch (command.name) {
      case "help":
        setSlashDismissed(false);
        setSlashHighlight(0);
        setSlashMenuOpen(true);
        setText("");
        break;
      case "new":
        onNewThread();
        setText("");
        break;
      case "clear":
        setText("");
        break;
      case "model": {
        const query = args.toLowerCase();
        const match = models.find(
          (model) =>
            model.id.toLowerCase().includes(query) ||
            model.displayName.toLowerCase().includes(query) ||
            model.modelID.toLowerCase().includes(query),
        );
        if (!match) {
          onError("未找到匹配的模型，请检查模型名称");
          return;
        }
        onStateChange({ ...state, model: match.id });
        setText("");
        break;
      }
      case "access":
        onStateChange({ ...state, fullAccess: !state.fullAccess });
        setText("");
        break;
      default:
        onError(`命令 /${command.name} 暂不可用`);
    }
  };

  const selectSlashCommand = (command: SlashCommand) => {
    if (command.needsArg) {
      setText(`/${command.name} `);
      setSlashDismissed(false);
      setSlashMenuOpen(true);
      composerRef.current?.focus();
      return;
    }
    setSlashMenuOpen(false);
    setText("");
    void runSlashCommand(command, "");
  };

  const submit = () => {
    const parsed = parseSlash(text);
    if (parsed?.escaped) {
      void send(parsed.args);
      return;
    }
    if (parsed) {
      const command = matchSlashCommand(parsed.command);
      if (command) {
        if (command.needsArg && !parsed.args) {
          setText(`/${command.name} `);
          setSlashDismissed(false);
          setSlashMenuOpen(true);
          composerRef.current?.focus();
          return;
        }
        setSlashMenuOpen(false);
        setText("");
        void runSlashCommand(command, parsed.args);
        return;
      }
    }
    if (editing) {
      void retry();
      return;
    }
    void send();
  };

  const startEdit = (originalText: string) => {
    setEditing(true);
    setText(originalText);
    setSlashMenuOpen(false);
    composerRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditing(false);
    setText("");
  };

  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    onError("");
    try {
      await api.cancelTurn(thread.id);
      onTurnCancelled();
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="conversation-layout">
      <header className="conversation-header">
        <div className="conversation-title">
          <div className="conversation-state-icon">{active ? <LoaderCircle className="spin" size={18} /> : <MessageSquare size={18} />}</div>
          <div><h1>{thread.title?.trim().split("\n")[0]?.slice(0, 68) || "未命名会话"}</h1><p>{thread.cwd}</p></div>
        </div>
      </header>

      <div
        className="conversation-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const scroller = event.currentTarget;
          atBottomRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
        }}
      >
        {loading ? (
          <div className="history-loading"><LoaderCircle className="spin" size={20} />加载历史记录</div>
        ) : (
          <div className="history-stream">
            {blocks.map((block, index) => (
              <BlockView
                key={block.id}
                block={block}
                live={active && index === blocks.length - 1}
                editable={!active && index === blocks.length - 1}
                onEdit={startEdit}
              />
            ))}
            {blocks.length === 0 && <div className="new-thread-state"><Bot size={25} /><h2>新会话</h2><p>在下方输入第一项需求。</p></div>}
          </div>
        )}
      </div>

      {pendingRequests.length > 0 && (
        <PermissionBar api={api} requests={pendingRequests} onError={onError} onRequestsChange={onRequestsChange} />
      )}

      <footer className="composer-shell">
        {editing && (
          <div className="edit-mode-bar">
            <Pencil size={13} />
            <span>正在修改上一条需求：发送后将回滚原回复并重新执行</span>
            <button type="button" onClick={cancelEdit} aria-label="取消修改">取消</button>
          </div>
        )}
        <div className="composer-toolbar">
          <select
            className="model-select"
            value={state.model ?? ""}
            aria-label="模型"
            onChange={(event) => onStateChange({ ...state, model: event.target.value || null })}
          >
            <option value="">默认模型</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.displayName}（{model.providerID}）</option>
            ))}
          </select>
          <button
            type="button"
            className={`access-toggle ${state.fullAccess ? "on" : ""}`}
            aria-pressed={state.fullAccess}
            title="完全访问：自动允许 opencode 的权限请求"
            onClick={() => onStateChange({ ...state, fullAccess: !state.fullAccess })}
          >
            <ShieldAlert size={14} />{state.fullAccess ? "完全访问" : "受限权限"}
          </button>
        </div>
        <div className="composer">
          <button
            type="button"
            className="slash-button"
            title="斜杠命令"
            aria-label="斜杠命令"
            aria-expanded={slashMenuOpen}
            onClick={() => {
              setSlashDismissed(false);
              setSlashHighlight(0);
              setSlashMenuOpen((current) => !current);
            }}
          >
            <Slash size={16} />
          </button>
          <textarea
            ref={composerRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && slashMenuOpen) {
                event.preventDefault();
                setSlashMenuOpen(false);
                setSlashDismissed(true);
                return;
              }
              if (slashMenuOpen && slashMatches.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashHighlight((current) => (current + 1) % slashMatches.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashHighlight((current) => (current - 1 + slashMatches.length) % slashMatches.length);
                  return;
                }
              }
              if (event.key !== "Enter") return;
              if (event.nativeEvent.isComposing) return;
              if (isMobileLayout) return;
              if (event.shiftKey) return;
              event.preventDefault();
              if (slashMenuOpen && !slashParsed && slashMatches.length > 0) {
                const highlighted = slashMatches[slashHighlight];
                if (highlighted) {
                  selectSlashCommand(highlighted);
                  return;
                }
              }
              submit();
            }}
            placeholder={
              editing
                ? "修改需求后发送，将重新执行"
                : active
                  ? "任务进行中"
                  : isMobileLayout
                    ? "输入需求，回车换行"
                    : "发送新的需求"
            }
            rows={1}
          />
          {active ? (
            <button
              className="send-button cancel-button"
              onClick={() => void cancel()}
              disabled={cancelling}
              title="取消任务"
              aria-label="取消任务"
            >
              {cancelling ? <LoaderCircle className="spin" size={18} /> : <Square size={16} />}
            </button>
          ) : (
            <button
              className="send-button"
              onClick={() => submit()}
              disabled={sending || !text.trim()}
              title={editing ? "重新发送" : "发送"}
            >
              {sending ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}
            </button>
          )}
        </div>
        {slashMenuOpen && (
          <div className="slash-menu" role="listbox" aria-label="斜杠命令">
            {slashMatches.length === 0 ? (
              <div className="slash-menu-empty">没有匹配的命令（以 // 开头可发送原文）</div>
            ) : (
              slashMatches.map((command, index) => (
                <button
                  key={command.name}
                  type="button"
                  role="option"
                  aria-selected={index === slashHighlight}
                  className={`slash-item ${index === slashHighlight ? "highlighted" : ""}`}
                  onMouseEnter={() => setSlashHighlight(index)}
                  onClick={() => selectSlashCommand(command)}
                >
                  <span className="slash-name">/{command.name}</span>
                  <span className="slash-desc">
                    {command.description}
                    {command.usage ? ` — ${command.usage}` : ""}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </footer>
    </div>
  );
}

function BlockView({ block, live, editable, onEdit }: {
  block: Block;
  live: boolean;
  editable: boolean;
  onEdit: (text: string) => void;
}) {
  const userText = block.user
    ? block.user.parts.filter((part) => part.type === "text").map(partText).join("\n")
    : "";
  return (
    <section className="turn-block" data-status={live ? "inProgress" : "completed"}>
      {block.user && (
        <article className="message user-message">
          <div className="message-label">
            <User size={14} />你
            {editable && userText && (
              <button type="button" className="edit-message-button" aria-label="修改这条需求" title="修改这条需求" onClick={() => onEdit(userText)}>
                <Pencil size={12} />
              </button>
            )}
          </div>
          <div className="message-body">{userText}</div>
        </article>
      )}
      {block.assistants.map((message) => (
        <AssistantView key={message.info.id} message={message} live={live && message === block.assistants[block.assistants.length - 1]} />
      ))}
      {live && <div className="working-indicator"><LoaderCircle className="spin" size={15} />opencode 正在处理</div>}
      {block.assistants.some((message) => message.info.error !== null && message.info.error !== undefined) && (
        <div className="turn-error"><CircleAlert size={16} />{stringify(block.assistants[block.assistants.length - 1]?.info.error)}</div>
      )}
    </section>
  );
}

function AssistantView({ message, live }: { message: Message; live: boolean }) {
  const parts = message.parts.filter((part) => part.type !== "step-start" && part.type !== "step-finish");
  const finalTexts = parts.filter((part) => part.type === "text").map(partText).filter(Boolean);
  const processParts = parts.filter((part) => part.type !== "text");
  return (
    <>
      {processParts.map((part, index) => <PartView key={part.id ?? `${message.info.id}-${index}`} part={part} live={live} />)}
      {finalTexts.length > 0 && (
        <article className="message agent-message">
          <div className="message-label"><Bot size={15} />opencode</div>
          <div className="message-body markdown-body"><MarkdownContent content={finalTexts.join("\n\n")} /></div>
        </article>
      )}
    </>
  );
}

const toolStatusLabel = (value: unknown): string =>
  ({ pending: "等待中", running: "进行中", completed: "完成", error: "失败" })[String(value)] ?? "";

function PartView({ part, live }: { part: Part; live: boolean }) {
  const detailProps = live ? { open: true, "data-always-open": "" } : {};
  if (part.type === "reasoning") {
    return <details className="reasoning-item" {...detailProps}><summary><CircleDot size={15} />思考过程</summary><pre>{partText(part) || "正在思考..."}</pre></details>;
  }
  if (part.type === "tool") {
    const state = toolState(part);
    const status = state.status;
    const tool = String(part.tool ?? "工具调用");
    const input = isRecord(state.input) ? state.input : {};
    if (tool === "bash") {
      return (
        <details className="tool-item command-item compact-tool" {...detailProps}>
          <summary><TerminalSquare size={15} />命令<span className={`tool-status ${String(status ?? "")}`}>{toolStatusLabel(status)}</span></summary>
          <code>{String(input.command ?? state.title ?? "")}</code>
          {state.output ? <pre>{String(state.output)}</pre> : null}
        </details>
      );
    }
    if (tool === "edit" || tool === "write" || tool === "apply_patch") {
      const filePath = String(input.filePath ?? input.path ?? state.title ?? "文件");
      return (
        <details className="tool-item file-item compact-tool" {...detailProps}>
          <summary><FileCode2 size={15} />文件修改<span className={`tool-status ${String(status ?? "")}`}>{toolStatusLabel(status)}</span></summary>
          <ul><li>{filePath}</li></ul>
          {input.diff ? <pre>{String(input.diff)}</pre> : null}
        </details>
      );
    }
    return (
      <details className="tool-item compact-tool" {...detailProps}>
        <summary><Wrench size={15} />{tool}<span className={`tool-status ${String(status ?? "")}`}>{toolStatusLabel(status)}</span></summary>
        <pre>{stringify({ input, output: state.output })}</pre>
      </details>
    );
  }
  if (part.type === "patch") {
    const files = Array.isArray(part.files) ? part.files.map(String) : [];
    if (files.length === 0) return null;
    return (
      <details className="tool-item file-item compact-tool" {...detailProps}>
        <summary><FileCode2 size={15} />文件变更</summary>
        <ul>{files.map((file, index) => <li key={index}>{file}</li>)}</ul>
      </details>
    );
  }
  if (part.type === "file") {
    return (
      <div className="system-note"><FileCode2 size={14} />附件：{String(part.filename ?? part.url ?? "文件")}</div>
    );
  }
  return null;
}

export function PermissionBar({ api, requests, onError, onRequestsChange }: {
  api: OpencodeApiClient;
  requests: PendingPermission[];
  onError: (value: string) => void;
  onRequestsChange: (value: PendingPermission[]) => void;
}) {
  const request = requests[0]!;
  const metadata = request.metadata ?? {};
  const command = typeof metadata.command === "string" ? metadata.command : null;
  const description = typeof metadata.description === "string" ? metadata.description : null;
  const filePath = typeof metadata.filepath === "string" ? metadata.filepath : typeof metadata.filePath === "string" ? metadata.filePath : null;
  const title =
    request.permission === "bash" ? "确认执行命令"
      : request.permission === "edit" ? "确认文件修改"
        : `确认 ${request.permission}`;
  const respond = async (reply: "once" | "always" | "reject") => {
    try {
      const result = await api.respondToRequest(request.key, { reply });
      onRequestsChange((result.pendingRequests ?? requests.filter((entry) => entry.key !== request.key)) as PendingPermission[]);
    } catch (error) {
      onError(errorMessage(error));
    }
  };
  return (
    <section className="approval-bar">
      <ShieldAlert size={18} />
      <div className="approval-content">
        <strong>{title}</strong>
        <p>{command || filePath || description || request.patterns.join("、") || "opencode 需要确认后继续"}</p>
      </div>
      {requests.length > 1 && <span className="count-badge">{requests.length}</span>}
      <button className="secondary-button" onClick={() => void respond("reject")} title="拒绝"><X size={14} />拒绝</button>
      <button className="secondary-button" onClick={() => void respond("always")} title="本次会话内总是允许">总是允许</button>
      <button className="primary-button compact" onClick={() => void respond("once")}><Check size={16} />允许</button>
    </section>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}

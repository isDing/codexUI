import type { Model, Preferences, Thread, ThreadItem, Turn } from "./types";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const errorMessage = (value: unknown): string => (value instanceof Error ? value.message : "操作失败");

export const userMessageText = (item: ThreadItem): string => {
  if (item.type !== "userMessage" || !Array.isArray(item.content)) return "";
  return item.content
    .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : ""))
    .filter(Boolean)
    .join("\n");
};

export const userMessageItem = (text: string): ThreadItem => ({
  id: `user-${Date.now()}`,
  type: "userMessage",
  content: [{ type: "text", text }],
});

export const ensureUserMessage = (turn: Turn, text: string): Turn =>
  turn.items.some((item) => userMessageText(item) === text)
    ? turn
    : { ...turn, items: [userMessageItem(text), ...turn.items] };

export const mergeTurn = (existing: Turn, incoming: Turn): Turn => {
  const incomingIds = new Set(incoming.items.map((item) => item.id).filter(Boolean));
  const incomingUserTexts = new Set(incoming.items.map(userMessageText).filter(Boolean));
  const existingOnly = existing.items.filter((item) => {
    const text = userMessageText(item);
    return (!item.id || !incomingIds.has(item.id)) && (!text || !incomingUserTexts.has(text));
  });
  const mergedItems = [...incoming.items, ...existingOnly];
  return {
    ...existing,
    ...incoming,
    items: [
      ...mergedItems.filter((item) => userMessageText(item) !== ""),
      ...mergedItems.filter((item) => userMessageText(item) === ""),
    ],
  };
};

export const mergeHistoricalTurns = (older: Turn[], current: Turn[]): Turn[] => {
  const currentIds = new Set(current.map((turn) => turn.id));
  return [...older.filter((turn) => !currentIds.has(turn.id)), ...current];
};

export const isProcessItem = (item: ThreadItem): boolean =>
  item.type === "reasoning" ||
  item.type === "plan" ||
  item.type === "commandExecution" ||
  item.type === "fileChange" ||
  ["mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch"].includes(item.type) ||
  (item.type === "agentMessage" && item.phase === "commentary");

export const modelFor = (models: Model[], value: string | null) =>
  models.find((model) => model.model === value || model.id === value) ??
  models.find((model) => model.isDefault) ??
  models[0];

export const normalizePreferences = (value: Preferences, models: Model[]): Preferences => {
  const model = modelFor(models, value.model);
  const effort = model?.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === value.effort)
    ? value.effort
    : model?.defaultReasoningEffort ?? null;
  return { model: model?.model ?? null, effort, fullAccess: value.fullAccess };
};

export const threadTitle = (thread: Thread): string =>
  thread.name?.trim() || thread.preview?.trim().split("\n")[0]?.slice(0, 68) || "未命名会话";

export const sourceLabel = (source: unknown): string => {
  const raw = typeof source === "string" ? source : isRecord(source) ? Object.keys(source)[0] ?? "Codex" : "Codex";
  const labels: Record<string, string> = { cli: "CLI", vscode: "VS Code", exec: "Exec", appServer: "Web", subAgent: "子代理" };
  return labels[raw] ?? raw;
};

export const relativeTime = (timestamp: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86400)} 天`;
};

export const effortLabel = (value: string): string =>
  ({ none: "无", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大", ultra: "极高" })[value] ?? value;

export const toolStatus = (value: unknown): string =>
  ({ inProgress: "进行中", completed: "完成", failed: "失败", declined: "已拒绝" })[String(value)] ?? "";

export const toolName = (item: ThreadItem): string =>
  String(item.tool ?? (item.type === "webSearch" ? "网页搜索" : "工具调用"));

export const changePath = (change: unknown): string => {
  if (!isRecord(change)) return stringify(change);
  return String(change.path ?? change.filePath ?? Object.keys(change)[0] ?? "文件");
};

export const approvalTitle = (method: string): string =>
  method.includes("requestUserInput")
    ? "Codex 需要你的回答"
    : method.includes("fileChange")
      ? "确认文件修改"
      : method.includes("commandExecution")
        ? "确认执行命令"
        : "Codex 等待确认";

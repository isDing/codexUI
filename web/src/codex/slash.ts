export type SlashCommandKind = "local" | "rpc";

export type SlashCommand = {
  /** 命令名（不含斜杠），前缀匹配即可触发 */
  name: string;
  description: string;
  /** 参数说明，展示在菜单里 */
  usage?: string;
  /** 是否需要参数：需要时先回填 /name ␣ 再让用户继续输入，否则选中即执行 */
  needsArg: boolean;
  kind: SlashCommandKind;
  /** 仅任务进行中可用 */
  activeOnly?: boolean;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "查看所有命令", needsArg: false, kind: "local" },
  { name: "new", description: "新建会话", needsArg: false, kind: "local" },
  { name: "model", description: "切换模型", usage: "<模型名称>", needsArg: true, kind: "local" },
  { name: "effort", description: "切换思考强度", usage: "<级别>", needsArg: true, kind: "local" },
  { name: "access", description: "切换完全访问开关", needsArg: false, kind: "local" },
  { name: "clear", description: "清空输入框", needsArg: false, kind: "local" },
  { name: "rename", description: "重命名当前会话", usage: "<新名称>", needsArg: true, kind: "rpc" },
  { name: "archive", description: "归档/取消归档当前会话", needsArg: false, kind: "rpc" },
  { name: "compact", description: "立即整理上下文", needsArg: false, kind: "rpc" },
  { name: "goal", description: "设置会话目标", usage: "<目标内容>", needsArg: true, kind: "rpc" },
  { name: "steer", description: "给进行中的任务追加指令", usage: "<指令>", needsArg: true, kind: "rpc", activeOnly: true },
];

/** 从输入文本解析斜杠命令：返回命令与参数；文本以 // 开头视为转义（普通消息） */
export const parseSlash = (text: string): { command: string; args: string; escaped: boolean } | null => {
  if (!text.startsWith("/")) return null;
  if (text.startsWith("//")) return { command: "", args: text.slice(1), escaped: true };
  const rest = text.slice(1);
  const space = rest.indexOf(" ");
  const command = (space >= 0 ? rest.slice(0, space) : rest).trim();
  const args = space >= 0 ? rest.slice(space + 1).trim() : "";
  return { command, args, escaped: false };
};

/** 前缀匹配命令；唯一匹配时返回该命令 */
export const matchSlashCommand = (name: string): SlashCommand | null => {
  if (!name) return null;
  const matches = SLASH_COMMANDS.filter((entry) => entry.name.startsWith(name.toLowerCase()));
  return matches.length === 1 ? matches[0]! : null;
};

/** 菜单候选：按前缀过滤（空前缀返回全部） */
export const filterSlashCommands = (prefix: string): SlashCommand[] => {
  const query = prefix.toLowerCase();
  return SLASH_COMMANDS.filter((entry) => entry.name.startsWith(query));
};

import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { AppConfig } from "./config.js";
import type { JsonObject, RpcMessage } from "./types.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class CodexAppServer extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelayMs = 1_000;

  constructor(private readonly config: AppConfig) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.ensureReady();
  }

  async request<T = unknown>(method: string, params: JsonObject = {}, timeoutMs = 30_000): Promise<T> {
    await this.ensureReady();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const current = this.process;
    this.process = null;
    this.readyPromise = null;
    if (current && !current.killed) current.kill("SIGTERM");
    this.rejectPending(new Error("Codex app-server stopped"));
  }

  private ensureReady(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.launch();
    return this.readyPromise;
  }

  private async launch(): Promise<void> {
    this.emit("status", { connected: false, message: "正在连接 Codex" });
    const child = spawn(this.config.codexBin, ["app-server"], {
      cwd: this.config.workspaceRoots[0],
      env: {
        ...process.env,
        ...(this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));

    const errorLines = readline.createInterface({ input: child.stderr });
    errorLines.on("line", (line) => {
      if (line.trim()) this.emit("diagnostic", line.trim());
    });

    child.on("error", (error) => this.handleExit(error));
    child.on("exit", (code, signal) => {
      this.handleExit(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
    });

    await this.sendRequest("initialize", {
      clientInfo: { name: "codex_ui", title: "Codex UI", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized", params: {} });
    this.restartDelayMs = 1_000;
    this.emit("status", { connected: true, message: "Codex 已连接" });
  }

  private sendRequest<T = unknown>(method: string, params: JsonObject, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(message: RpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not available");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.emit("diagnostic", `Ignored malformed Codex message: ${line.slice(0, 160)}`);
      return;
    }

    if (message.id !== undefined && !message.method && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  private handleExit(error: Error): void {
    if (!this.process && this.readyPromise === null) return;
    this.process = null;
    this.readyPromise = null;
    this.rejectPending(error);
    this.emit("status", { connected: false, message: "Codex 连接已断开" });
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensureReady().catch((launchError) => this.emit("diagnostic", String(launchError)));
    }, delay);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

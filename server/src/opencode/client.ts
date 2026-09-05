import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import readline from "node:readline";
import type { AppConfig } from "../config.js";

const getFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("Cannot allocate a local port"))));
    });
  });

export type OpencodeRequestOptions = {
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
};

export class OpencodeClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private baseUrl = "";
  private authHeader = "";
  private readyPromise: Promise<void> | null = null;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelayMs = 1_000;
  private readonly subscriptions = new Set<string>();
  private readonly loops = new Map<string, AbortController>();
  private alive = false;

  constructor(private readonly config: AppConfig) {
    super();
  }

  get connected(): boolean {
    return this.alive;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.ensureReady();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRestartTimer();
    await this.terminate();
  }

  async request<T = unknown>(method: string, path: string, options: OpencodeRequestOptions = {}): Promise<T> {
    await this.ensureReady();
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: this.authHeader,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`opencode ${method} ${path} 失败 (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`opencode ${method} ${path} 返回了非 JSON 响应`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`opencode 请求超时: ${method} ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private ensureReady(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("opencode server is stopped"));
    this.clearRestartTimer();
    if (!this.readyPromise) this.readyPromise = this.launch();
    return this.readyPromise;
  }

  private async launch(): Promise<void> {
    this.emit("status", { connected: false, message: "正在连接 opencode" });
    const port = await getFreePort();
    const password = crypto.randomBytes(24).toString("base64url");
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

    const child = spawn(this.config.opencodeBin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: this.config.workspaceRoots[0],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.process = child;

    const errorLines = readline.createInterface({ input: child.stderr! });
    errorLines.on("line", (line) => {
      if (line.trim()) this.emit("diagnostic", line.trim());
    });

    child.on("error", () => this.handleExit(child));
    child.on("exit", () => this.handleExit(child));

    try {
      await this.waitForHealth(child);
    } catch (error) {
      const message = error instanceof Error ? error : new Error(String(error));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      this.handleExit(child);
      throw message;
    }
    this.restartDelayMs = 1_000;
    this.alive = true;
    this.emit("status", { connected: true, message: "opencode 已连接" });
    // 进程重启后 baseUrl 已变化：为所有已订阅目录重建 SSE 循环
    for (const directory of this.subscriptions) this.startEventLoop(directory);
  }

  private async waitForHealth(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("opencode serve 在就绪前退出");
      try {
        const response = await fetch(new URL("/global/health", this.baseUrl), {
          headers: { authorization: this.authHeader },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          const body = (await response.json().catch(() => null)) as { healthy?: boolean } | null;
          if (body?.healthy) return;
        }
      } catch {
        // 服务尚未监听该端口：继续轮询
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("opencode serve 启动超时");
  }

  /** 为某个目录维持一条 /event SSE 连接；重复调用无副作用 */
  subscribe(directory: string): void {
    if (this.subscriptions.has(directory)) return;
    this.subscriptions.add(directory);
    if (this.alive) this.startEventLoop(directory);
  }

  private startEventLoop(directory: string): void {
    if (this.loops.has(directory)) return;
    const child = this.process;
    if (!child) return;
    const abort = new AbortController();
    this.loops.set(directory, abort);
    void this.eventLoop(directory, child, abort).finally(() => {
      if (this.loops.get(directory) === abort) this.loops.delete(directory);
      if (!this.stopped && this.subscriptions.has(directory) && this.process === child && this.alive) {
        const timer = setTimeout(() => this.startEventLoop(directory), 1_000);
        timer.unref();
      }
    });
  }

  private async eventLoop(directory: string, child: ChildProcess, abort: AbortController): Promise<void> {
    while (!this.stopped && this.process === child && this.loops.get(directory) === abort) {
      try {
        const url = new URL("/event", this.baseUrl);
        url.searchParams.set("directory", directory);
        const response = await fetch(url, {
          headers: { authorization: this.authHeader, accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) throw new Error(`opencode SSE 连接失败 (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                this.emit("event", JSON.parse(payload) as { type?: string; properties?: Record<string, unknown> });
              } catch {
                this.emit("diagnostic", `Ignored malformed opencode SSE payload: ${payload.slice(0, 120)}`);
              }
            }
          }
        }
      } catch (error) {
        if (this.stopped || this.process !== child) return;
        this.emit("diagnostic", `opencode SSE(${directory}) 中断: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (this.stopped || this.process !== child) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private abortAllLoops(): void {
    for (const abort of this.loops.values()) abort.abort();
    this.loops.clear();
  }

  private async terminate(): Promise<void> {
    const current = this.process;
    this.process = null;
    this.readyPromise = null;
    this.alive = false;
    this.abortAllLoops();
    if (current && current.exitCode === null && current.signalCode === null) {
      const exited = new Promise<void>((resolve) => current.once("exit", () => resolve()));
      current.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
      if (current.exitCode === null && current.signalCode === null) current.kill("SIGKILL");
    }
  }

  private handleExit(child: ChildProcess): void {
    if (this.process !== child) return;
    this.process = null;
    this.readyPromise = null;
    this.alive = false;
    this.abortAllLoops();
    this.emit("status", { connected: false, message: "opencode 连接已断开" });
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensureReady().catch((launchError) => this.emit("diagnostic", String(launchError)));
    }, delay);
  }
}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import {
  createSession,
  expiredSessionCookie,
  parseCookies,
  requireAuth,
  requireCsrf,
  resolveSession,
  SESSION_COOKIE,
  sessionCookie,
} from "./auth.js";
import { verifyPassword } from "./security.js";
import type { RouteContext } from "./context.js";
import { jsonError } from "./context.js";
import type { CodexService } from "./codex/service.js";
import { registerCodexRoutes } from "./codex/routes.js";
import type { OpencodeService } from "./opencode/service.js";
import { registerOpencodeRoutes } from "./opencode/routes.js";

export type ServiceHub = {
  codex: CodexService;
  opencode: OpencodeService | null;
};

const loginSchema = z.object({ username: z.string().trim().min(1).max(120), password: z.string().min(1).max(1_000) });
const LOGIN_ATTEMPT_LIMIT = 8;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60_000;
const LOGIN_ATTEMPT_BUCKET_LIMIT = 4_096;
const LOGIN_ATTEMPT_PRUNE_INTERVAL_MS = 60_000;

const touch = (request: Request, db: AppDatabase): void => {
  if (request.authTokenHash) db.touchSession(request.authTokenHash, Date.now());
};

export const createApp = (config: AppConfig, db: AppDatabase, hub: ServiceHub): Express => {
  const app = express();
  // 生产拓扑固定为一层 Nginx；不能信任客户端提供的更早代理地址。
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      strictTransportSecurity: false,
      contentSecurityPolicy:
        config.nodeEnv === "development"
          ? false
          : {
              directives: {
                defaultSrc: ["'self'"],
                baseUri: ["'self'"],
                connectSrc: ["'self'", "wss:", "ws:"],
                fontSrc: ["'self'", "data:"],
                imgSrc: ["'self'", "data:"],
                objectSrc: ["'none'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                frameAncestors: ["'none'"],
                upgradeInsecureRequests: null,
              },
            },
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  // API 响应一律禁止缓存：会话数据敏感且变化频繁，
  // 客户端已有内存缓存层，HTTP 层不应产生 304 往返
  app.use("/api", (_request: Request, response: Response, next: () => void) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  // 请求日志：记录方法、路径、状态码与耗时（跳过健康检查噪音）
  app.use((request: Request, response: Response, next: () => void) => {
    if (request.path === "/api/health") {
      next();
      return;
    }
    if (!request.path.startsWith("/api") && request.path !== "/") {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    response.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`${request.method} ${request.originalUrl} ${response.statusCode} ${ms.toFixed(1)}ms ip=${request.ip ?? "-"}`);
    });
    next();
  });

  const originGuard = (request: Request, response: Response, next: () => void): void => {
    const origin = request.headers.origin;
    if (origin && origin !== config.allowedOrigin) {
      response.status(403).json({ error: "来源不被允许" });
      return;
    }
    next();
  };
  app.use("/api", originGuard);

  const auth = requireAuth(db, config);
  const attempts = new Map<string, { count: number; resetAt: number }>();
  let nextAttemptsPruneAt = 0;
  const pruneAttempts = (now: number): void => {
    if (now < nextAttemptsPruneAt && attempts.size < LOGIN_ATTEMPT_BUCKET_LIMIT) return;
    for (const [address, attempt] of attempts) {
      if (attempt.resetAt <= now) attempts.delete(address);
    }
    while (attempts.size >= LOGIN_ATTEMPT_BUCKET_LIMIT) {
      const oldest = attempts.keys().next().value;
      if (oldest === undefined) break;
      attempts.delete(oldest);
    }
    nextAttemptsPruneAt = now + LOGIN_ATTEMPT_PRUNE_INTERVAL_MS;
  };
  app.post("/api/auth/login", async (request, response) => {
    const now = Date.now();
    pruneAttempts(now);
    const address = request.ip || "unknown";
    const attempt = attempts.get(address);
    if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_ATTEMPT_LIMIT) {
      response.status(429).json({ error: "登录尝试过于频繁，请稍后再试" });
      return;
    }
    if (attempt && attempt.resetAt <= now) attempts.delete(address);
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.username !== config.adminUser || !(await verifyPassword(parsed.data.password, config.adminPasswordHash))) {
      const current = attempts.get(address) ?? { count: 0, resetAt: now + LOGIN_ATTEMPT_WINDOW_MS };
      current.count += 1;
      attempts.set(address, current);
      response.status(401).json({ error: "用户名或密码不正确" });
      return;
    }
    attempts.delete(address);
    db.purgeExpiredSessions(now, config.sessionIdleMs);
    const session = createSession(db, config, now);
    response.setHeader("Set-Cookie", sessionCookie(session.token, config.secureCookies, config.sessionIdleMs));
    response.json({ authenticated: true, username: config.adminUser, csrfToken: session.csrfToken, expiresAt: now + config.sessionIdleMs });
  });

  app.get("/api/auth/session", (request, response) => {
    const resolved = resolveSession(request.headers.cookie, db, config);
    if (!resolved) {
      response.json({ authenticated: false });
      return;
    }
    response.json({
      authenticated: true,
      username: resolved.session.username,
      csrfToken: resolved.session.csrfToken,
      expiresAt: resolved.session.expiresAt,
    });
  });

  app.post("/api/auth/activity", auth, requireCsrf, (request: Request, response: Response) => {
    const now = Date.now();
    touch(request, db);
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) response.setHeader("Set-Cookie", sessionCookie(token, config.secureCookies, config.sessionIdleMs));
    response.json({ expiresAt: now + config.sessionIdleMs });
  });

  app.post("/api/auth/logout", auth, requireCsrf, (request: Request, response: Response) => {
    if (request.authTokenHash) db.deleteSession(request.authTokenHash);
    response.setHeader("Set-Cookie", expiredSessionCookie(config.secureCookies));
    response.json({ authenticated: false });
  });

  app.get("/api/meta", auth, (_request, response) => {
    response.json({ backends: hub.opencode ? ["codex", "opencode"] : ["codex"] });
  });

  const ctx: RouteContext = { config, db, auth, touch: (request) => touch(request, db) };
  registerCodexRoutes(app, ctx, hub.codex);
  if (hub.opencode) registerOpencodeRoutes(app, ctx, hub.opencode);

  app.get("/api/health", (_request, response) =>
    response.json({
      ok: true,
      service: "codex-ui",
      codexConnected: hub.codex.codexConnected,
      opencodeConnected: hub.opencode?.ocConnected ?? null,
    }),
  );

  // 未匹配的 API 路由返回 JSON 404，避免落到 SPA 兜底返回 HTML
  app.use("/api", (_request: Request, response: Response) => {
    response.status(404).json({ error: "接口不存在" });
  });

  const staticDir = path.resolve(process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url)));
  if (fs.existsSync(staticDir)) {
    // 带哈希的资源文件可长期缓存；index.html 与 SPA 路由回退一律不缓存，保证发版后立即生效
    app.use("/assets", express.static(path.join(staticDir, "assets"), { maxAge: "1y", immutable: true }));
    const sendIndex = (_request: Request, response: Response): void => {
      response.setHeader("Cache-Control", "no-store");
      response.sendFile(path.join(staticDir, "index.html"));
    };
    app.get("/", sendIndex);
    app.get("*splat", (request: Request, response: Response) => {
      if (request.path.startsWith("/api") || request.path.startsWith("/assets")) {
        response.status(404).json({ error: "资源不存在" });
        return;
      }
      sendIndex(request, response);
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
    if (isJsonSyntaxError(error)) {
      response.status(400).json({ error: "请求体不是有效的 JSON" });
      return;
    }
    if (isRecord(error) && error.type === "entity.too.large") {
      response.status(413).json({ error: "请求体过大" });
      return;
    }
    console.error(error);
    jsonError(response, 500, "服务器内部错误");
  });
  return app;
};

const isJsonSyntaxError = (error: unknown): boolean =>
  error instanceof SyntaxError && isRecord(error) && error.type === "entity.parse.failed";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const createWebSocketHandler = (config: AppConfig, db: AppDatabase, hub: ServiceHub) => {
  const clients = new Map<WebSocket, { clientId: string; tokenHash: string; lastTouchAt: number }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const send = (socket: WebSocket, message: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    // 正在接收推送的客户端视为活跃：节流续期，避免长时间观看任务输出时被登出
    const client = clients.get(socket);
    if (client) {
      const now = Date.now();
      if (now - client.lastTouchAt >= 30_000) {
        client.lastTouchAt = now;
        db.touchSession(client.tokenHash, now);
      }
    }
    socket.send(JSON.stringify(message));
  };
  const broadcast = (message: unknown): void => {
    for (const socket of clients.keys()) send(socket, message);
  };
  hub.codex.on("event", (event: unknown) => broadcast({ backend: "codex", ...(event as object) }));
  hub.opencode?.on("event", (event: unknown) => broadcast({ backend: "opencode", ...(event as object) }));

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const resolved = resolveSession(request.headers.cookie, db, config);
    if (!resolved) {
      socket.close(1008, "登录已过期");
      return;
    }
    const clientId = crypto.randomUUID();
    const client = { clientId, tokenHash: resolved.tokenHash, lastTouchAt: Date.now() };
    clients.set(socket, client);
    void hub.codex
      .snapshot()
      .then((snapshot) => send(socket, { backend: "codex", type: "snapshot", payload: snapshot }))
      .catch(() => send(socket, { backend: "codex", type: "error", payload: { message: "无法加载初始状态" } }));
    if (hub.opencode) {
      void hub.opencode
        .snapshot()
        .then((snapshot) => send(socket, { backend: "opencode", type: "snapshot", payload: snapshot }))
        .catch(() => send(socket, { backend: "opencode", type: "error", payload: { message: "无法加载初始状态" } }));
    }
    send(socket, { backend: "shared", type: "connection", payload: { connected: true, message: "实时连接已建立" } });

    socket.on("message", (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          backend?: string;
          threadId?: string | null;
        };
        if (message.type === "viewing") {
          const target = message.backend === "opencode" ? hub.opencode : hub.codex;
          target?.setViewer(clientId, message.threadId ?? null);
        }
        if (message.type === "ping") send(socket, { type: "pong", at: Date.now() });
      } catch {
        send(socket, { type: "error", payload: { message: "无法解析实时消息" } });
      }
    });
    socket.on("close", () => {
      clients.delete(socket);
      hub.codex.removeViewer(clientId);
      hub.opencode?.removeViewer(clientId);
    });
  });

  const expiryTimer = setInterval(() => {
    const now = Date.now();
    for (const [socket, client] of clients) {
      if (!db.getSession(client.tokenHash, now, config.sessionIdleMs)) {
        send(socket, { type: "auth.expired" });
        socket.close(1008, "登录已过期");
      }
    }
  }, 30_000);
  expiryTimer.unref();

  return {
    wss,
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const origin = request.headers.origin;
      if (origin && origin !== config.allowedOrigin) {
        socket.destroy();
        return;
      }
      const resolved = resolveSession(request.headers.cookie, db, config);
      if (!resolved) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit("connection", client, request);
      });
    },
  };
};

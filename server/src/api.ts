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
import { CodexService } from "./codex-service.js";

const loginSchema = z.object({ username: z.string().trim().min(1).max(120), password: z.string().min(1).max(1_000) });
const threadSchema = z.object({
  cwd: z.string().min(1).max(4_000),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  fullAccess: z.boolean().default(false),
});
const workspaceSchema = z.object({ path: z.string().trim().min(1).max(4_000) });
const historyQuerySchema = z.object({ cursor: z.string().min(1).max(20_000) });
const turnSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  fullAccess: z.boolean().default(false),
});const approvalSchema = z.object({
  decision: z.enum(["accept", "decline"]).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
});

const idParam = z.string().min(1).max(200);
const cancelSchema = z.object({ turnId: z.string().min(1).max(200).optional() });
const commandSchema = z.object({
  command: z.enum(["rename", "archive", "unarchive", "compact", "goal", "steer"]),
  args: z.string().trim().max(2_000).optional(),
});

const jsonError = (response: Response, status: number, error: unknown): void => {
  const message = error instanceof Error ? error.message : "请求失败";
  response.status(status).json({ error: message });
};

const touch = (request: Request, db: AppDatabase): void => {
  if (request.authTokenHash) db.touchSession(request.authTokenHash, Date.now());
};

export const createApp = (config: AppConfig, db: AppDatabase, service: CodexService): Express => {
  const app = express();
  if (config.trustProxy) app.set("trust proxy", true);
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
  app.post("/api/auth/login", async (request, response) => {
    const now = Date.now();
    const address = request.ip || "unknown";
    const attempt = attempts.get(address);
    if (attempt && attempt.resetAt > now && attempt.count >= 8) {
      response.status(429).json({ error: "登录尝试过于频繁，请稍后再试" });
      return;
    }
    if (attempt && attempt.resetAt <= now) attempts.delete(address);
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.username !== config.adminUser || !(await verifyPassword(parsed.data.password, config.adminPasswordHash))) {
      const current = attempts.get(address) ?? { count: 0, resetAt: now + 15 * 60_000 };
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

  app.get("/api/bootstrap", auth, async (_request, response) => {
    try {
      response.json(await service.snapshot());
    } catch (error) {
      jsonError(response, 503, error);
    }
  });

  app.post("/api/workspaces", auth, requireCsrf, async (request: Request, response: Response) => {
    const parsed = workspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "工作区路径无效" });
      return;
    }
    try {
      touch(request, db);
      response.status(201).json(await service.addWorkspace(parsed.data.path));
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.get("/api/threads/:threadId", auth, async (request, response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    if (!threadId.success) {
      response.status(400).json({ error: "会话 ID 无效" });
      return;
    }
    try {
      touch(request, db);
      response.json(await service.readThread(threadId.data));
    } catch (error) {
      jsonError(response, 404, error);
    }
  });

  app.get("/api/threads/:threadId/history", auth, async (request, response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    const query = historyQuerySchema.safeParse(request.query);
    if (!threadId.success || !query.success) {
      response.status(400).json({ error: "历史记录游标无效" });
      return;
    }
    try {
      touch(request, db);
      response.json(await service.readThreadHistory(threadId.data, query.data.cursor));
    } catch (error) {
      jsonError(response, 404, error);
    }
  });

  app.post("/api/threads", auth, requireCsrf, async (request: Request, response: Response) => {
    const parsed = threadSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "工作区或会话设置无效" });
      return;
    }
    try {
      touch(request, db);
      response.status(201).json(await service.createThread(parsed.data));
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/threads/:threadId/turns", auth, requireCsrf, async (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    const parsed = turnSchema.safeParse(request.body);
    if (!threadId.success || !parsed.success) {
      response.status(400).json({ error: "需求内容或会话设置无效" });
      return;
    }
    try {
      touch(request, db);
      response.status(202).json(
        await service.startTurn(threadId.data, {
          ...parsed.data,
          model: parsed.data.model ?? null,
          effort: parsed.data.effort ?? null,
        }),
      );
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/threads/:threadId/read", auth, requireCsrf, (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    if (!threadId.success) {
      response.status(400).json({ error: "会话 ID 无效" });
      return;
    }
    touch(request, db);
    service.markRead(threadId.data);
    response.json({ unreadThreadIds: db.unreadThreadIds() });
  });

  app.post("/api/threads/:threadId/retry", auth, requireCsrf, async (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    const parsed = turnSchema.safeParse(request.body);
    if (!threadId.success || !parsed.success) {
      response.status(400).json({ error: "需求内容或会话设置无效" });
      return;
    }
    try {
      touch(request, db);
      response.status(202).json(
        await service.retryTurn(threadId.data, {
          ...parsed.data,
          model: parsed.data.model ?? null,
          effort: parsed.data.effort ?? null,
        }),
      );
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/threads/:threadId/cancel", auth, requireCsrf, async (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    const body = cancelSchema.safeParse(request.body ?? {});
    if (!threadId.success || !body.success) {
      response.status(400).json({ error: "请求参数无效" });
      return;
    }
    try {
      touch(request, db);
      await service.cancelTurn(threadId.data, body.data.turnId);
      response.json({ ok: true });
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/threads/:threadId/command", auth, requireCsrf, async (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    const body = commandSchema.safeParse(request.body ?? {});
    if (!threadId.success || !body.success) {
      response.status(400).json({ error: "命令参数无效" });
      return;
    }
    try {
      touch(request, db);
      response.json(await service.runCommand(threadId.data, body.data.command, body.data.args));
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/requests/:key/respond", auth, requireCsrf, (request: Request, response: Response) => {
    const key = idParam.safeParse(request.params.key);
    const body = approvalSchema.safeParse(request.body);
    if (!key.success || !body.success) {
      response.status(400).json({ error: "响应格式无效" });
      return;
    }
    try {
      touch(request, db);
      service.respondToRequest(key.data, body.data);
      response.json({ pendingRequests: service.publicApprovals() });
    } catch (error) {
      jsonError(response, 404, error);
    }
  });

  app.get("/api/health", (_request, response) =>
    response.json({ ok: true, service: "codex-ui", codexConnected: service.codexConnected }),
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
    console.error(error);
    jsonError(response, 500, "服务器内部错误");
  });
  return app;
};

export const createWebSocketHandler = (config: AppConfig, db: AppDatabase, service: CodexService) => {
  const clients = new Map<WebSocket, { clientId: string; tokenHash: string; lastTouchAt: number }>();
  const wss = new WebSocketServer({ noServer: true });

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
  service.on("event", (event: unknown) => broadcast(event));

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const resolved = resolveSession(request.headers.cookie, db, config);
    if (!resolved) {
      socket.close(1008, "登录已过期");
      return;
    }
    const clientId = crypto.randomUUID();
    const client = { clientId, tokenHash: resolved.tokenHash, lastTouchAt: Date.now() };
    clients.set(socket, client);
    void service.snapshot().then((snapshot) => send(socket, { type: "snapshot", payload: snapshot }));
    send(socket, { type: "connection", payload: { connected: true, message: "实时连接已建立" } });

    socket.on("message", (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; threadId?: string | null };
        if (message.type === "viewing") service.setViewer(clientId, message.threadId ?? null);
        if (message.type === "ping") send(socket, { type: "pong", at: Date.now() });
      } catch {
        send(socket, { type: "error", payload: { message: "无法解析实时消息" } });
      }
    });
    socket.on("close", () => {
      clients.delete(socket);
      service.removeViewer(clientId);
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

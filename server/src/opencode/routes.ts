import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireCsrf } from "../auth.js";
import type { RouteContext } from "../context.js";
import { jsonError } from "../context.js";
import type { OpencodeService } from "./service.js";

const threadSchema = z.object({
  cwd: z.string().min(1).max(4_000),
  model: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  fullAccess: z.boolean().default(false),
});
const workspaceSchema = z.object({ path: z.string().trim().min(1).max(4_000) });
const turnSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  model: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  fullAccess: z.boolean().default(false),
});
const approvalSchema = z.object({
  reply: z.enum(["once", "always", "reject"]).optional(),
  decision: z.enum(["accept", "decline"]).optional(),
});

const idParam = z.string().min(1).max(200);
const commandSchema = z.object({
  command: z.enum(["rename", "compact"]),
  args: z.string().trim().max(2_000).optional(),
});

export const registerOpencodeRoutes = (app: Express, ctx: RouteContext, service: OpencodeService): void => {
  const { auth, touch } = ctx;

  app.get("/api/opencode/bootstrap", auth, async (_request, response) => {
    try {
      response.json(await service.snapshot());
    } catch (error) {
      jsonError(response, 503, error);
    }
  });

  app.post("/api/opencode/workspaces", auth, requireCsrf, async (request: Request, response: Response) => {
    const parsed = workspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "工作区路径无效" });
      return;
    }
    try {
      touch(request);
      response.status(201).json(await service.addWorkspace(parsed.data.path));
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.get("/api/opencode/threads/:threadId", auth, async (request, response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    if (!threadId.success) {
      response.status(400).json({ error: "会话 ID 无效" });
      return;
    }
    try {
      touch(request);
      response.json(await service.readThread(threadId.data));
    } catch (error) {
      jsonError(response, 404, error);
    }
  });

  app.post("/api/opencode/threads", auth, requireCsrf, async (request: Request, response: Response) => {
    const parsed = threadSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "工作区或会话设置无效" });
      return;
    }
    try {
      touch(request);
      response.status(201).json(await service.createThread(parsed.data));
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/opencode/threads/:threadId/turns", auth, requireCsrf, async (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    const parsed = turnSchema.safeParse(request.body);
    if (!threadId.success || !parsed.success) {
      response.status(400).json({ error: "需求内容或会话设置无效" });
      return;
    }
    try {
      touch(request);
      response.status(202).json(
        await service.startTurn(threadId.data, {
          ...parsed.data,
          model: parsed.data.model ?? null,
          agent: parsed.data.agent ?? null,
        }),
      );
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/opencode/threads/:threadId/read", auth, requireCsrf, (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    if (!threadId.success) {
      response.status(400).json({ error: "会话 ID 无效" });
      return;
    }
    touch(request);
    service.markRead(threadId.data);
    response.json({ unreadThreadIds: ctx.db.ocUnreadThreadIds() });
  });

  app.delete("/api/opencode/threads/:threadId", auth, requireCsrf, async (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    if (!threadId.success) {
      response.status(400).json({ error: "会话 ID 无效" });
      return;
    }
    try {
      touch(request);
      await service.deleteThread(threadId.data);
      response.json({ ok: true });
    } catch (error) {
      jsonError(response, 404, error);
    }
  });

  app.post("/api/opencode/threads/:threadId/retry", auth, requireCsrf, async (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    const parsed = turnSchema.safeParse(request.body);
    if (!threadId.success || !parsed.success) {
      response.status(400).json({ error: "需求内容或会话设置无效" });
      return;
    }
    try {
      touch(request);
      response.status(202).json(
        await service.retryTurn(threadId.data, {
          ...parsed.data,
          model: parsed.data.model ?? null,
          agent: parsed.data.agent ?? null,
        }),
      );
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/opencode/threads/:threadId/cancel", auth, requireCsrf, async (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    if (!threadId.success) {
      response.status(400).json({ error: "请求参数无效" });
      return;
    }
    try {
      touch(request);
      await service.cancelTurn(threadId.data);
      response.json({ ok: true });
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/opencode/threads/:threadId/command", auth, requireCsrf, async (request: Request, response: Response) => {
    const threadId = idParam.safeParse(request.params.threadId);
    const body = commandSchema.safeParse(request.body ?? {});
    if (!threadId.success || !body.success) {
      response.status(400).json({ error: "命令参数无效" });
      return;
    }
    try {
      touch(request);
      response.json(await service.runCommand(threadId.data, body.data.command, body.data.args));
    } catch (error) {
      jsonError(response, 400, error);
    }
  });

  app.post("/api/opencode/requests/:key/respond", auth, requireCsrf, (request: Request, response: Response) => {
    const key = idParam.safeParse(request.params.key);
    const body = approvalSchema.safeParse(request.body);
    if (!key.success || !body.success) {
      response.status(400).json({ error: "响应格式无效" });
      return;
    }
    try {
      touch(request);
      service.respondToRequest(key.data, body.data);
      response.json({ pendingRequests: service.publicApprovals() });
    } catch (error) {
      jsonError(response, 404, error);
    }
  });
};

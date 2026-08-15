import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./database.js";
import { hashToken, randomToken } from "./security.js";
import type { SessionInfo } from "./types.js";

export const SESSION_COOKIE = "codexui_session";

declare global {
  namespace Express {
    interface Request {
      authSession?: SessionInfo;
      authTokenHash?: string;
    }
  }
}

export const parseCookies = (header: string | undefined): Record<string, string> => {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      if (index < 0) return [];
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      try {
        return [[key, decodeURIComponent(value)]];
      } catch {
        return [];
      }
    }),
  );
};

export const sessionCookie = (token: string, secure: boolean, idleMs: number): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(idleMs / 1000))}${secure ? "; Secure" : ""}`;

export const expiredSessionCookie = (secure: boolean): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;

export const createSession = (db: AppDatabase, config: AppConfig, now = Date.now()) => {
  const token = randomToken();
  const tokenHash = hashToken(token, config.sessionSecret);
  const csrfToken = randomToken(24);
  db.createSession(tokenHash, csrfToken, config.adminUser, now);
  return { token, tokenHash, csrfToken };
};

export const resolveSession = (
  cookieHeader: string | undefined,
  db: AppDatabase,
  config: AppConfig,
  now = Date.now(),
): { session: SessionInfo; tokenHash: string } | null => {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = hashToken(token, config.sessionSecret);
  const session = db.getSession(tokenHash, now, config.sessionIdleMs);
  return session ? { session, tokenHash } : null;
};

export const requireAuth = (db: AppDatabase, config: AppConfig) =>
  (request: Request, response: Response, next: NextFunction): void => {
    const resolved = resolveSession(request.headers.cookie, db, config);
    if (!resolved) {
      response.status(401).json({ error: "登录已过期，请重新登录" });
      return;
    }
    request.authSession = resolved.session;
    request.authTokenHash = resolved.tokenHash;
    next();
  };

export const requireCsrf = (request: Request, response: Response, next: NextFunction): void => {
  if (request.headers["x-csrf-token"] !== request.authSession?.csrfToken) {
    response.status(403).json({ error: "请求校验失败，请刷新页面后重试" });
    return;
  }
  next();
};

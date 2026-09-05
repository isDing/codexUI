import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./database.js";

export type RouteContext = {
  config: AppConfig;
  db: AppDatabase;
  auth: (request: Request, response: Response, next: NextFunction) => void;
  touch: (request: Request) => void;
};

export const jsonError = (response: Response, status: number, error: unknown): void => {
  const message = error instanceof Error ? error.message : "请求失败";
  response.status(status).json({ error: message });
};

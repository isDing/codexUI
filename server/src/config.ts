import fs from "node:fs";
import path from "node:path";

const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const readPackageVersion = (): string => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const splitPaths = (value: string): string[] =>
  value
    .split(":")
    .map((entry) => path.resolve(entry.trim()))
    .filter(Boolean);

export const loadConfig = () => ({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  nodeEnv: process.env.NODE_ENV ?? "development",
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  codexBin: process.env.CODEX_BIN ?? "codex",
  codexHome: process.env.CODEX_HOME,
  workspaceRoots: splitPaths(process.env.WORKSPACE_ROOTS ?? "/home/user/code"),
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173",
  adminUser: process.env.ADMIN_USER ?? "admin",
  adminPasswordHash: required("ADMIN_PASSWORD_HASH"),
  sessionSecret: required("SESSION_SECRET"),
  sessionIdleMs: Number(process.env.SESSION_IDLE_MS ?? 4 * 60 * 60 * 1000),
  secureCookies: process.env.SECURE_COOKIES !== "false",
  trustProxy: process.env.TRUST_PROXY === "true",
  pollIntervalMs: Number(process.env.CODEX_POLL_INTERVAL_MS ?? 3000),
  appVersion: readPackageVersion(),
});

export type AppConfig = ReturnType<typeof loadConfig>;

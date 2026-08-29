import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const integerEnv = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
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
    .split(path.delimiter)
    .map((entry) => path.resolve(entry.trim()))
    .filter(Boolean);

const validateOrigin = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ALLOWED_ORIGIN must be a valid http(s) origin");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("ALLOWED_ORIGIN must contain only an http(s) origin");
  }
  return parsed.origin;
};

const validatePasswordHash = (value: string): string => {
  const [algorithm, salt, encoded] = value.split("$");
  if (algorithm !== "scrypt" || !salt || !encoded) {
    throw new Error("ADMIN_PASSWORD_HASH must be a generated scrypt hash");
  }
  const derived = Buffer.from(encoded, "base64url");
  if (derived.length !== 64) throw new Error("ADMIN_PASSWORD_HASH contains an invalid derived key");
  return value;
};

export const loadConfig = () => {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  const workspaceRoots = splitPaths(process.env.WORKSPACE_ROOTS ?? path.join(os.homedir(), "code"));
  if (workspaceRoots.length === 0) throw new Error("WORKSPACE_ROOTS must contain at least one directory");
  return {
    port: integerEnv("PORT", 3000, 0, 65_535),
    host: process.env.HOST?.trim() || "0.0.0.0",
    nodeEnv,
    dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
    codexBin: process.env.CODEX_BIN ?? "codex",
    codexHome: process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : undefined,
    workspaceRoots,
    allowedOrigin: validateOrigin(process.env.ALLOWED_ORIGIN ?? "http://localhost:5173"),
    adminUser: required("ADMIN_USER", "admin").trim(),
    adminPasswordHash: validatePasswordHash(required("ADMIN_PASSWORD_HASH")),
    sessionSecret,
    sessionIdleMs: integerEnv("SESSION_IDLE_MS", 4 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
    secureCookies: process.env.SECURE_COOKIES === undefined ? nodeEnv === "production" : process.env.SECURE_COOKIES !== "false",
    trustProxy: process.env.TRUST_PROXY === "true",
    pollIntervalMs: integerEnv("CODEX_POLL_INTERVAL_MS", 3000, 250, 5 * 60_000),
    appVersion: readPackageVersion(),
  };
};

export type AppConfig = ReturnType<typeof loadConfig>;

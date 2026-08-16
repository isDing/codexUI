import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServer } from "./codex-app-server.js";
import type { AppConfig } from "./config.js";

const createFakeCodex = (directory: string): string => {
  const scriptPath = path.join(directory, "fake-codex.mjs");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.method === "identity" ? { pid: process.pid } : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
}
`,
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
};

const testConfig = (directory: string, codexBin: string): AppConfig => ({
  port: 0,
  host: "127.0.0.1",
  nodeEnv: "test",
  dataDir: directory,
  codexBin,
  codexHome: undefined,
  workspaceRoots: [directory],
  allowedOrigin: "http://codexui.test",
  adminUser: "admin",
  adminPasswordHash: "unused",
  sessionSecret: "test-session-secret-with-enough-entropy",
  sessionIdleMs: 4 * 60 * 60 * 1_000,
  secureCookies: false,
  trustProxy: false,
  pollIntervalMs: 3_000,
  appVersion: "test",
});

describe("Codex app-server lifecycle", () => {
  it("ignores exit events from an older process generation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexui-rpc-stale-"));
    const server = new CodexAppServer(testConfig(directory, "codex"));
    const currentProcess = {};
    const internals = server as unknown as {
      process: object | null;
      handleExit(child: object, error: Error): void;
    };
    internals.process = currentProcess;
    internals.handleExit({}, new Error("stale process exited"));
    expect(internals.process).toBe(currentProcess);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("waits for a complete restart before sending new requests", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexui-rpc-"));
    const server = new CodexAppServer(testConfig(directory, createFakeCodex(directory)));
    try {
      await server.start();
      const first = await server.request<{ pid: number }>("identity");
      const restarting = server.restart(20);
      const second = await server.request<{ pid: number }>("identity");
      await restarting;
      expect(second.pid).not.toBe(first.pid);
      await expect(server.request<{ pid: number }>("identity")).resolves.toEqual(second);
    } finally {
      await server.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "./database.js";
import { CodexService, preferencesFromPersistedSettings, preferencesFromRuntimeSettings } from "./codex-service.js";
import type { AppConfig } from "./config.js";
import type { CodexThread, CodexTurn } from "./types.js";
import { hashPassword, verifyPassword } from "./security.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("password hashing", () => {
  it("accepts the original password and rejects another value", async () => {
    const hash = await hashPassword("a sufficiently long password");
    await expect(verifyPassword("a sufficiently long password", hash)).resolves.toBe(true);
    await expect(verifyPassword("a different password", hash)).resolves.toBe(false);
  });
});

describe("session and thread state", () => {
  it("expires a session after the configured idle interval", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexui-test-"));
    tempDirs.push(directory);
    const db = new AppDatabase(directory);
    db.createSession("token", "csrf", "admin", 1_000);
    expect(db.getSession("token", 4_999, 4_000)?.username).toBe("admin");
    expect(db.getSession("token", 5_000, 4_000)).toBeNull();
    db.close();
  });

  it("persists per-thread settings and unread completion state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexui-test-"));
    tempDirs.push(directory);
    const db = new AppDatabase(directory);
    db.setPreferences("thread-1", { model: "gpt-test", effort: "high", fullAccess: true });
    db.markUnread("thread-1", 10);
    expect(db.getPreferences("thread-1")).toEqual({ model: "gpt-test", effort: "high", fullAccess: true });
    expect(db.unreadThreadIds()).toEqual(["thread-1"]);
    db.markRead("thread-1");
    expect(db.unreadThreadIds()).toEqual([]);
    db.close();
  });

  it("persists added workspace paths", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexui-workspace-"));
    tempDirs.push(directory);
    const db = new AppDatabase(directory);
    db.addWorkspacePath("/home/user/code/example");
    db.addWorkspacePath("/home/user/code/example");
    expect(db.workspacePaths()).toEqual(["/home/user/code/example"]);
    db.close();
  });
});

describe("thread settings restoration", () => {
  it("maps the app-server resume settings to the visible session controls", () => {
    expect(
      preferencesFromRuntimeSettings({
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite", writableRoots: [] },
      }),
    ).toEqual({ model: "gpt-5.6-sol", effort: "xhigh", fullAccess: false });
    expect(
      preferencesFromRuntimeSettings({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
        activePermissionProfile: { id: ":danger-full-access" },
      }),
    ).toEqual({ model: "gpt-5.6-sol", effort: "high", fullAccess: true });
  });

  it("uses persisted rollout settings when an active writer cannot be resumed", () => {
    expect(
      preferencesFromPersistedSettings({
        model: "gpt-5.6-terra",
        reasoning_effort: "ultra",
        approval_policy: "on-request",
        active_permission_profile: { id: ":workspace" },
        permission_profile: { type: "managed" },
      }),
    ).toEqual({ model: "gpt-5.6-terra", effort: "ultra", fullAccess: false });
    expect(
      preferencesFromPersistedSettings({
        model: "gpt-5.6-sol",
        reasoning_effort: "xhigh",
        approval_policy: "never",
        active_permission_profile: { id: ":danger-full-access" },
        permission_profile: { type: "disabled" },
      }),
    ).toEqual({ model: "gpt-5.6-sol", effort: "xhigh", fullAccess: true });
  });
});

describe("thread history pagination", () => {
  it("loads the newest turns first and pages backwards through the app-server", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexui-history-"));
    tempDirs.push(directory);
    const db = new AppDatabase(directory);
    db.setPreferences("thread-history", { model: "gpt-5.6-sol", effort: "high", fullAccess: false });
    const rolloutPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(rolloutPath, [
      JSON.stringify({ payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-old", reasoning_effort: "low" } } }),
      "malformed historical line",
      JSON.stringify({ payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-latest", reasoning_effort: "xhigh", approval_policy: "never", sandbox_mode: "danger-full-access" } } }),
    ].join("\n"));
    const config: AppConfig = {
      port: 0,
      host: "127.0.0.1",
      nodeEnv: "test",
      dataDir: directory,
      codexBin: "codex",
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
    };
    const turn = (id: string): CodexTurn => ({
      id,
      items: [{ id: `item-${id}`, type: "agentMessage", text: id }],
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
    });
    const thread: CodexThread = {
      id: "thread-history",
      sessionId: "session-history",
      parentThreadId: null,
      preview: "history",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: { type: "idle" },
      path: rolloutPath,
      cwd: directory,
      cliVersion: "0.147.0",
      source: "appServer",
      name: null,
      turns: [],
    };
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const service = new CodexService(config, db);
    const internals = service as unknown as {
      rpc: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
    };
    internals.rpc.request = async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread };
      if (method === "thread/turns/list" && !params?.cursor) {
        return { data: [turn("turn-4"), turn("turn-3")], nextCursor: "older-turns" };
      }
      if (method === "thread/turns/list" && params?.cursor === "older-turns") {
        return { data: [turn("turn-2"), turn("turn-1")], nextCursor: null };
      }
      throw new Error(`unexpected RPC: ${method}`);
    };

    const initial = await service.readThread(thread.id);
    expect(initial.thread.turns.map((entry) => entry.id)).toEqual(["turn-3", "turn-4"]);
    expect(initial.nextCursor).toBe("older-turns");
    expect(initial.preferences).toEqual({ model: "gpt-latest", effort: "xhigh", fullAccess: true });
    expect(calls.find((call) => call.method === "thread/read")?.params).toEqual({
      threadId: thread.id,
      includeTurns: false,
    });
    expect(calls.find((call) => call.method === "thread/turns/list")?.params).toMatchObject({
      threadId: thread.id,
      limit: 2,
      sortDirection: "desc",
      itemsView: "full",
    });

    const older = await service.readThreadHistory(thread.id, initial.nextCursor);
    expect(older.turns.map((entry) => entry.id)).toEqual(["turn-1", "turn-2"]);
    expect(older.nextCursor).toBeNull();
    expect(calls.at(-1)?.params).toMatchObject({ cursor: "older-turns", limit: 4 });

    await service.stop();
    db.close();
  });
});

describe("new thread materialization", () => {
  it("starts the first turn without reading or resuming an unmaterialized thread", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexui-new-thread-"));
    tempDirs.push(directory);
    const db = new AppDatabase(directory);
    const config: AppConfig = {
      port: 0,
      host: "127.0.0.1",
      nodeEnv: "test",
      dataDir: directory,
      codexBin: "codex",
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
    };
    const service = new CodexService(config, db);
    const thread: CodexThread = {
      id: "thread-new",
      sessionId: "session-new",
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      recencyAt: 1,
      status: { type: "notLoaded" },
      path: null,
      cwd: directory,
      cliVersion: "0.147.0",
      source: "appServer",
      name: null,
      turns: [],
    };
    const calls: string[] = [];
    const internals = service as unknown as {
      rpc: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
      threads: Map<string, CodexThread>;
    };
    internals.rpc.request = async (method) => {
      calls.push(method);
      if (method === "thread/start") return { thread, model: "gpt-5.6-sol", reasoningEffort: "medium" };
      if (method === "turn/start") return { turn: { id: "turn-new" } };
      throw new Error(`unexpected RPC: ${method}`);
    };

    await service.createThread({ cwd: directory, model: "gpt-5.6-sol", effort: "medium", fullAccess: false });
    internals.threads.delete(thread.id);
    await service.startTurn(thread.id, { text: "hello", model: "gpt-5.6-sol", effort: "medium", fullAccess: false });

    expect(calls).toEqual(["thread/start", "turn/start"]);
    await service.stop();
    db.close();
  });
});

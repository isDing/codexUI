import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./api.js";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { hashPassword } from "./security.js";
import type { CodexService } from "./codex-service.js";

class FakeService extends EventEmitter {
  async snapshot() {
    return { connected: true, threads: [], workspaces: [], models: [], unreadThreadIds: [], pendingRequests: [] };
  }
}

describe("authentication API", () => {
  let dataDir: string;
  let db: AppDatabase;
  let config: AppConfig;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexui-api-"));
    config = {
      port: 0,
      host: "127.0.0.1",
      nodeEnv: "test",
      dataDir,
      codexBin: "codex",
      codexHome: undefined,
      workspaceRoots: [dataDir],
      allowedOrigin: "http://codexui.test",
      adminUser: "admin",
      adminPasswordHash: await hashPassword("valid test password"),
      sessionSecret: "test-session-secret-with-enough-entropy",
      sessionIdleMs: 4 * 60 * 60 * 1_000,
      secureCookies: false,
      trustProxy: false,
      pollIntervalMs: 3_000,
    };
    db = new AppDatabase(dataDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("requires valid credentials and a CSRF token for writes", async () => {
    const app = createApp(config, db, new FakeService() as unknown as CodexService);
    await request(app)
      .post("/api/auth/login")
      .set("origin", config.allowedOrigin)
      .send({ username: "admin", password: "wrong" })
      .expect(401);

    const agent = request.agent(app);
    const login = await agent
      .post("/api/auth/login")
      .set("origin", config.allowedOrigin)
      .send({ username: "admin", password: "valid test password" })
      .expect(200);

    expect(login.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    await agent.post("/api/auth/activity").set("origin", config.allowedOrigin).expect(403);
    const activity = await agent
      .post("/api/auth/activity")
      .set("origin", config.allowedOrigin)
      .set("x-csrf-token", login.body.csrfToken)
      .expect(200);
    expect(activity.headers["set-cookie"]?.[0]).toContain("Max-Age=14400");
    await agent.get("/api/bootstrap").expect(200);
  });

  it("rejects an unsafe request from another origin", async () => {
    const app = createApp(config, db, new FakeService() as unknown as CodexService);
    await request(app)
      .post("/api/auth/login")
      .set("origin", "https://attacker.example")
      .send({ username: "admin", password: "valid test password" })
      .expect(403);
  });
});

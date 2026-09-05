import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { OpencodeClient } from "./client.js";

const fakeScript = `#!/usr/bin/env node
import http from "node:http";
const index = process.argv.indexOf("--port");
const port = Number(process.argv[index + 1] ?? 0);
const expected = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
const session = { id: "ses_fake", directory: "/tmp/fake", title: "fake session", time: { created: 1, updated: 1 } };
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== expected) {
    response.writeHead(401).end();
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/global/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ healthy: true, version: "fake" }));
    return;
  }
  if (url.pathname === "/session" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{ ...session, directory: url.searchParams.get("directory") ?? session.directory }]));
    return;
  }
  if (url.pathname === "/session" && request.method === "POST") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(session));
    return;
  }
  if (url.pathname === "/event") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => {
      response.write("data: " + JSON.stringify({ type: "session.status", properties: { sessionID: "ses_fake", status: { type: "busy" } } }) + "\\n\\n");
    }, 20);
    request.on("close", () => clearInterval(timer));
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

const testConfig = (directory: string, opencodeBin: string): AppConfig => ({
  port: 0,
  host: "127.0.0.1",
  nodeEnv: "test",
  dataDir: directory,
  codexBin: "codex",
  codexHome: undefined,
  opencodeEnabled: true,
  opencodeBin,
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

describe("OpencodeClient lifecycle", () => {
  let directory: string;
  let binPath: string;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexui-opencode-"));
    binPath = path.join(directory, "fake-opencode.mjs");
    fs.writeFileSync(binPath, fakeScript);
    fs.chmodSync(binPath, 0o755);
  });

  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("starts the server, performs authenticated requests, and streams SSE events", async () => {
    const client = new OpencodeClient(testConfig(directory, binPath));
    try {
      await client.start();
      expect(client.connected).toBe(true);

      const sessions = await client.request<Array<{ id: string; directory: string }>>("GET", "/session", {
        query: { directory: "/workspace/demo" },
      });
      expect(sessions[0]?.id).toBe("ses_fake");
      expect(sessions[0]?.directory).toBe("/workspace/demo");

      const created = await client.request<{ id: string }>("POST", "/session", {
        query: { directory: "/workspace/demo" },
        body: {},
      });
      expect(created.id).toBe("ses_fake");

      const eventPromise = once(client, "event");
      client.subscribe("/workspace/demo");
      const [event] = (await Promise.race([
        eventPromise,
        new Promise((resolve) => setTimeout(() => resolve([]), 5_000)),
      ])) as [{ type?: string; properties?: Record<string, unknown> }];
      expect(event?.type).toBe("session.status");
      expect((event?.properties as { sessionID?: string })?.sessionID).toBe("ses_fake");
    } finally {
      await client.stop();
    }
    expect(client.connected).toBe(false);
  });

  it("surfaces HTTP errors with status details", async () => {
    const client = new OpencodeClient(testConfig(directory, binPath));
    try {
      await client.start();
      await expect(client.request("GET", "/missing")).rejects.toThrow(/404/);
    } finally {
      await client.stop();
    }
  });
});

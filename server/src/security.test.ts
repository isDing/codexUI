import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "./database.js";
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
});

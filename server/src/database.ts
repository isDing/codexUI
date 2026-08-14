import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionInfo, ThreadPreferences } from "./types.js";

type SessionRow = {
  token_hash: string;
  csrf_token: string;
  username: string;
  last_activity_at: number;
};

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "codexui.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        username TEXT NOT NULL,
        last_activity_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_preferences (
        thread_id TEXT PRIMARY KEY,
        model TEXT,
        effort TEXT,
        full_access INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_notices (
        thread_id TEXT PRIMARY KEY,
        unread INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS workspace_paths (
        path TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);
  }

  createSession(tokenHash: string, csrfToken: string, username: string, now: number): void {
    this.db
      .prepare("INSERT INTO sessions (token_hash, csrf_token, username, last_activity_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, csrfToken, username, now);
  }

  getSession(tokenHash: string, now: number, idleMs: number): SessionInfo | null {
    const row = this.db
      .prepare("SELECT token_hash, csrf_token, username, last_activity_at FROM sessions WHERE token_hash = ?")
      .get(tokenHash) as SessionRow | undefined;
    if (!row) return null;
    if (now - row.last_activity_at >= idleMs) {
      this.deleteSession(tokenHash);
      return null;
    }
    return {
      id: row.token_hash,
      csrfToken: row.csrf_token,
      username: row.username,
      lastActivityAt: row.last_activity_at,
      expiresAt: row.last_activity_at + idleMs,
    };
  }

  touchSession(tokenHash: string, now: number): void {
    this.db.prepare("UPDATE sessions SET last_activity_at = ? WHERE token_hash = ?").run(now, tokenHash);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  purgeExpiredSessions(now: number, idleMs: number): void {
    this.db.prepare("DELETE FROM sessions WHERE last_activity_at <= ?").run(now - idleMs);
  }

  getPreferences(threadId: string): ThreadPreferences {
    const row = this.db
      .prepare("SELECT model, effort, full_access FROM thread_preferences WHERE thread_id = ?")
      .get(threadId) as { model: string | null; effort: string | null; full_access: number } | undefined;
    return row
      ? { model: row.model, effort: row.effort, fullAccess: row.full_access === 1 }
      : { model: null, effort: null, fullAccess: false };
  }

  setPreferences(threadId: string, value: ThreadPreferences, now = Date.now()): void {
    this.db
      .prepare(`
        INSERT INTO thread_preferences (thread_id, model, effort, full_access, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          model = excluded.model,
          effort = excluded.effort,
          full_access = excluded.full_access,
          updated_at = excluded.updated_at
      `)
      .run(threadId, value.model, value.effort, value.fullAccess ? 1 : 0, now);
  }

  addWorkspacePath(workspacePath: string, now = Date.now()): void {
    this.db.prepare("INSERT OR IGNORE INTO workspace_paths (path, created_at) VALUES (?, ?)").run(workspacePath, now);
  }

  workspacePaths(): string[] {
    const rows = this.db.prepare("SELECT path FROM workspace_paths ORDER BY created_at ASC").all() as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  markUnread(threadId: string, completedAt = Date.now()): void {
    this.db
      .prepare(`
        INSERT INTO thread_notices (thread_id, unread, completed_at)
        VALUES (?, 1, ?)
        ON CONFLICT(thread_id) DO UPDATE SET unread = 1, completed_at = excluded.completed_at
      `)
      .run(threadId, completedAt);
  }

  markRead(threadId: string): void {
    this.db
      .prepare("INSERT INTO thread_notices (thread_id, unread, completed_at) VALUES (?, 0, 0) ON CONFLICT(thread_id) DO UPDATE SET unread = 0")
      .run(threadId);
  }

  unreadThreadIds(): string[] {
    const rows = this.db.prepare("SELECT thread_id FROM thread_notices WHERE unread = 1").all() as Array<{
      thread_id: string;
    }>;
    return rows.map((row) => row.thread_id);
  }

  close(): void {
    this.db.close();
  }
}

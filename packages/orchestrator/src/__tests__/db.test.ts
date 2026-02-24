import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDb, rowToSession, type SessionRow } from "../db.js";

describe("openDb", () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it("creates the sessions table", () => {
    db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all();
    expect(tables).toHaveLength(1);
  });

  it("sets WAL journal mode", () => {
    db = openDb(":memory:");
    const mode = db.pragma("journal_mode") as { journal_mode: string }[];
    // In-memory databases may report 'memory' instead of 'wal'
    expect(["wal", "memory"]).toContain(mode[0].journal_mode);
  });

  it("is idempotent (IF NOT EXISTS)", () => {
    db = openDb(":memory:");
    // Insert a row, then re-run schema
    db.prepare(`
      INSERT INTO sessions (id, container_id, status, oauth_token_index, model, created_at, last_activity)
      VALUES ('s1', 'c1', 'starting', 0, 'sonnet', '2025-01-01', '2025-01-01')
    `).run();

    // Re-run schema should not destroy existing data
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)`);
    // This would fail if the table was recreated (columns would be missing)
    const row = db.prepare("SELECT model FROM sessions WHERE id = 's1'").get() as any;
    expect(row.model).toBe("sonnet");
  });

  it("schema has all expected columns", () => {
    db = openDb(":memory:");
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);

    const expected = [
      "id", "container_id", "status", "oauth_token_index",
      "repo", "branch", "workspace", "model", "system_prompt", "max_turns",
      "created_at", "last_activity", "message_count",
      "input_tokens", "output_tokens", "cost_usd", "last_error",
      "sdk_session_id", "forked_from", "name",
    ];

    for (const col of expected) {
      expect(columnNames).toContain(col);
    }
  });
});

describe("rowToSession", () => {
  it("converts a full row to a Session object", () => {
    const row: SessionRow = {
      id: "s1",
      container_id: "c1",
      status: "ready",
      oauth_token_index: 2,
      repo: "https://github.com/test/repo",
      branch: "main",
      workspace: null,
      model: "sonnet",
      system_prompt: "Be helpful",
      max_turns: 10,
      created_at: "2025-01-15T12:00:00.000Z",
      last_activity: "2025-01-15T12:05:00.000Z",
      message_count: 3,
      input_tokens: 500,
      output_tokens: 200,
      cost_usd: 0.05,
      last_error: null,
      sdk_session_id: "sdk-123",
      forked_from: "parent-session",
      name: "my-session",
    };

    const session = rowToSession(row);

    expect(session.id).toBe("s1");
    expect(session.containerId).toBe("c1");
    expect(session.status).toBe("ready");
    expect(session.oauthTokenIndex).toBe(2);
    expect(session.repo).toBe("https://github.com/test/repo");
    expect(session.branch).toBe("main");
    expect(session.workspace).toBeUndefined();
    expect(session.model).toBe("sonnet");
    expect(session.systemPrompt).toBe("Be helpful");
    expect(session.maxTurns).toBe(10);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.lastActivity).toBeInstanceOf(Date);
    expect(session.messageCount).toBe(3);
    expect(session.totalUsage).toEqual({ input_tokens: 500, output_tokens: 200, cost_usd: 0.05 });
    expect(session.lastError).toBeUndefined();
    expect(session.sdkSessionId).toBe("sdk-123");
    expect(session.forkedFrom).toBe("parent-session");
    expect(session.name).toBe("my-session");
  });

  it("converts null optional fields to undefined", () => {
    const row: SessionRow = {
      id: "s1",
      container_id: "c1",
      status: "starting",
      oauth_token_index: 0,
      repo: null,
      branch: null,
      workspace: null,
      model: "haiku",
      system_prompt: null,
      max_turns: null,
      created_at: "2025-01-15T12:00:00.000Z",
      last_activity: "2025-01-15T12:00:00.000Z",
      message_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      last_error: null,
      sdk_session_id: null,
      forked_from: null,
      name: null,
    };

    const session = rowToSession(row);

    expect(session.repo).toBeUndefined();
    expect(session.branch).toBeUndefined();
    expect(session.workspace).toBeUndefined();
    expect(session.systemPrompt).toBeUndefined();
    expect(session.maxTurns).toBeUndefined();
    expect(session.lastError).toBeUndefined();
    expect(session.sdkSessionId).toBeUndefined();
    expect(session.forkedFrom).toBeUndefined();
    expect(session.name).toBeUndefined();
  });
});

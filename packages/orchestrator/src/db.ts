import Database from "better-sqlite3";
import type { Session, SessionStatus } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'starting',
  oauth_token_index INTEGER NOT NULL,
  repo TEXT,
  branch TEXT,
  workspace TEXT,
  model TEXT NOT NULL,
  system_prompt TEXT,
  max_turns INTEGER,
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  last_error TEXT,
  sdk_session_id TEXT,
  forked_from TEXT,
  name TEXT,
  pinned INTEGER NOT NULL DEFAULT 0
);
`;

const SNAPSHOTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS context_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  request_id TEXT,
  trigger TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  roles TEXT,
  messages TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON context_snapshots(session_id);
`;

export interface SnapshotRow {
  id: number;
  session_id: string;
  request_id: string | null;
  trigger: string;
  message_count: number;
  roles: string | null;
  messages: string;
  created_at: string;
}

export interface SessionRow {
  id: string;
  container_id: string;
  status: string;
  oauth_token_index: number;
  repo: string | null;
  branch: string | null;
  workspace: string | null;
  model: string;
  system_prompt: string | null;
  max_turns: number | null;
  created_at: string;
  last_activity: string;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  last_error: string | null;
  sdk_session_id: string | null;
  forked_from: string | null;
  name: string | null;
  pinned: number;
  context_tokens: number;
  compact_count: number;
  last_compact_at: string | null;
  vault_name: string | null;
}

// Idempotent migrations for columns added after initial schema
const MIGRATIONS = [
  "ALTER TABLE sessions ADD COLUMN name TEXT",
  "ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN compact_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN last_compact_at TEXT",
  "ALTER TABLE sessions ADD COLUMN vault_name TEXT",
];

function runMigrations(db: Database.Database): void {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec(SNAPSHOTS_SCHEMA);
  runMigrations(db);
  return db;
}

export function insertSnapshot(
  db: Database.Database,
  sessionId: string,
  trigger: string,
  messageCount: number,
  roles: string[],
  messages: any[],
  requestId?: string,
): number {
  const stmt = db.prepare(`
    INSERT INTO context_snapshots (session_id, request_id, trigger, message_count, roles, messages, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    sessionId,
    requestId ?? null,
    trigger,
    messageCount,
    JSON.stringify(roles),
    JSON.stringify(messages),
    new Date().toISOString(),
  );
  return result.lastInsertRowid as number;
}

export function listSnapshots(
  db: Database.Database,
  sessionId: string,
): SnapshotRow[] {
  const stmt = db.prepare(
    "SELECT id, session_id, request_id, trigger, message_count, roles, created_at FROM context_snapshots WHERE session_id = ? ORDER BY id DESC"
  );
  return stmt.all(sessionId) as SnapshotRow[];
}

export function getSnapshot(
  db: Database.Database,
  snapshotId: number,
): SnapshotRow | undefined {
  const stmt = db.prepare("SELECT * FROM context_snapshots WHERE id = ?");
  return stmt.get(snapshotId) as SnapshotRow | undefined;
}

export function rowToSession(row: SessionRow): Session & { oauthTokenIndex: number } {
  return {
    id: row.id,
    containerId: row.container_id,
    status: row.status as SessionStatus,
    oauthTokenIndex: row.oauth_token_index,
    repo: row.repo ?? undefined,
    branch: row.branch ?? undefined,
    workspace: row.workspace ?? undefined,
    model: row.model,
    systemPrompt: row.system_prompt ?? undefined,
    maxTurns: row.max_turns ?? undefined,
    createdAt: new Date(row.created_at),
    lastActivity: new Date(row.last_activity),
    messageCount: row.message_count,
    totalUsage: {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cost_usd: row.cost_usd,
    },
    lastError: row.last_error ?? undefined,
    sdkSessionId: row.sdk_session_id ?? undefined,
    forkedFrom: row.forked_from ?? undefined,
    name: row.name ?? undefined,
    pinned: row.pinned === 1,
    contextTokens: row.context_tokens ?? 0,
    compactCount: row.compact_count ?? 0,
    lastCompactAt: row.last_compact_at ? new Date(row.last_compact_at) : undefined,
    vaultName: row.vault_name ?? undefined,
  };
}

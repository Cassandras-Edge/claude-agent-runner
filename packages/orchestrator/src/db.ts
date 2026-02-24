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
  last_error TEXT
);
`;

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
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
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
  };
}

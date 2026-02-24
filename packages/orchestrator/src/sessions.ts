import type Database from "better-sqlite3";
import type { Session, SessionStatus, Usage } from "./types.js";
import type { SessionRow } from "./db.js";
import { rowToSession } from "./db.js";

export class SessionManager {
  private db: Database.Database;

  // Runtime-only state (WebSocket refs, pending resolves) — not persisted
  private runtime = new Map<string, { ws?: import("ws").default; pendingResolve?: (event: any) => void }>();

  constructor(db: Database.Database) {
    this.db = db;

    // Mark any sessions that were "starting"/"cloning"/"ready"/"busy"/"idle" as stopped
    // (they were interrupted by an orchestrator restart)
    this.db.prepare(`
      UPDATE sessions SET status = 'stopped', last_activity = ?
      WHERE status NOT IN ('stopped', 'error')
    `).run(new Date().toISOString());
  }

  create(id: string, containerId: string, oauthTokenIndex: number, config: {
    name?: string;
    repo?: string;
    branch?: string;
    workspace?: string;
    model: string;
    systemPrompt?: string;
    maxTurns?: number;
    forkedFrom?: string;
  }): Session {
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO sessions (id, container_id, status, oauth_token_index, name, repo, branch, workspace, model, system_prompt, max_turns, forked_from, created_at, last_activity)
      VALUES (?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, containerId, oauthTokenIndex,
      config.name ?? null,
      config.repo ?? null, config.branch ?? null, config.workspace ?? null,
      config.model, config.systemPrompt ?? null, config.maxTurns ?? null,
      config.forkedFrom ?? null,
      now, now,
    );

    return this.get(id)!;
  }

  get(id: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) return undefined;

    const session = rowToSession(row);
    const rt = this.runtime.get(id);
    if (rt) {
      session.ws = rt.ws;
      session.pendingResolve = rt.pendingResolve;
    }
    return session;
  }

  list(): Session[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as SessionRow[];
    return rows.map((row) => {
      const session = rowToSession(row);
      const rt = this.runtime.get(row.id);
      if (rt) {
        session.ws = rt.ws;
        session.pendingResolve = rt.pendingResolve;
      }
      return session;
    });
  }

  updateStatus(id: string, status: SessionStatus): void {
    this.db.prepare("UPDATE sessions SET status = ?, last_activity = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  setError(id: string, error: string): void {
    this.db.prepare("UPDATE sessions SET status = 'error', last_error = ?, last_activity = ? WHERE id = ?")
      .run(error, new Date().toISOString(), id);
  }

  setSdkSessionId(id: string, sdkSessionId: string): void {
    this.db.prepare("UPDATE sessions SET sdk_session_id = ?, last_activity = ? WHERE id = ?")
      .run(sdkSessionId, new Date().toISOString(), id);
  }

  incrementMessages(id: string): void {
    this.db.prepare("UPDATE sessions SET message_count = message_count + 1, last_activity = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  addUsage(id: string, usage: Usage): void {
    this.db.prepare(`
      UPDATE sessions SET
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cost_usd = cost_usd + ?
      WHERE id = ?
    `).run(usage.input_tokens, usage.output_tokens, usage.cost_usd, id);
  }

  remove(id: string): Session | undefined {
    const session = this.get(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    this.runtime.delete(id);
    return session;
  }

  activeCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM sessions WHERE status NOT IN ('stopped', 'error')").get() as { count: number };
    return row.count;
  }

  /** Get the token index assigned to a session. */
  getTokenIndex(id: string): number | undefined {
    const row = this.db.prepare("SELECT oauth_token_index FROM sessions WHERE id = ?").get(id) as { oauth_token_index: number } | undefined;
    return row?.oauth_token_index;
  }

  /** Get all active session token indices (for reconstructing token pool state). */
  activeTokenIndices(): { sessionId: string; tokenIndex: number }[] {
    const rows = this.db.prepare(
      "SELECT id, oauth_token_index FROM sessions WHERE status NOT IN ('stopped', 'error')"
    ).all() as { id: string; oauth_token_index: number }[];
    return rows.map((r) => ({ sessionId: r.id, tokenIndex: r.oauth_token_index }));
  }

  /** Get the max token index ever used (for resuming round-robin). */
  maxTokenIndex(): number | undefined {
    const row = this.db.prepare("SELECT MAX(oauth_token_index) as max_idx FROM sessions").get() as { max_idx: number | null };
    return row.max_idx ?? undefined;
  }

  /** Rename a session. Returns false if the name is already taken by another session. */
  rename(id: string, name: string): boolean {
    const existing = this.db.prepare(
      "SELECT id FROM sessions WHERE name = ? AND id != ?"
    ).get(name, id) as { id: string } | undefined;
    if (existing) return false;

    this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
    return true;
  }

  /** Check if a session name is already in use. */
  nameExists(name: string): boolean {
    const row = this.db.prepare("SELECT id FROM sessions WHERE name = ?").get(name) as { id: string } | undefined;
    return !!row;
  }

  // --- Runtime-only state management ---

  setWs(id: string, ws: import("ws").default): void {
    const rt = this.runtime.get(id) || {};
    rt.ws = ws;
    this.runtime.set(id, rt);
  }

  getWs(id: string): import("ws").default | undefined {
    return this.runtime.get(id)?.ws;
  }

  setPendingResolve(id: string, resolve: ((event: any) => void) | undefined): void {
    const rt = this.runtime.get(id) || {};
    rt.pendingResolve = resolve;
    this.runtime.set(id, rt);
  }

  clearRuntime(id: string): void {
    this.runtime.delete(id);
  }
}

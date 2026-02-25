import type Database from "better-sqlite3";
import type { Session, SessionStatus, Usage } from "./types.js";
import type { SessionRow } from "./db.js";
import { rowToSession } from "./db.js";
import { logger } from "./logger.js";

export class SessionManager {
  private db: Database.Database;

  // Runtime-only state (WebSocket refs, pending resolves) — not persisted
  private runtime = new Map<string, { ws?: import("ws").default; pendingResolve?: (event: any) => void }>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(id: string, containerId: string, oauthTokenIndex: number, config: {
    name?: string;
    pinned?: boolean;
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
      INSERT INTO sessions (id, container_id, status, oauth_token_index, name, pinned, repo, branch, workspace, model, system_prompt, max_turns, forked_from, created_at, last_activity)
      VALUES (?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, containerId, oauthTokenIndex,
      config.name ?? null,
      config.pinned ? 1 : 0,
      config.repo ?? null, config.branch ?? null, config.workspace ?? null,
      config.model, config.systemPrompt ?? null, config.maxTurns ?? null,
      config.forkedFrom ?? null,
      now, now,
    );
    logger.info("orchestrator.session", "created_session", {
      session_id: id,
      container_id: containerId,
      model: config.model,
      source_type: config.repo ? "repo" : config.workspace ? "workspace" : "ephemeral",
      pinned: !!config.pinned,
      forked_from: config.forkedFrom,
    });

    return this.get(id)!;
  }

  get(id: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) return undefined;
    logger.debug("orchestrator.session", "fetched_session", { session_id: id });

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
    logger.debug("orchestrator.session", "listed_sessions", { count: rows.length });
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
    logger.debug("orchestrator.session", "status_update", { session_id: id, status });
    this.db.prepare("UPDATE sessions SET status = ?, last_activity = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  setError(id: string, error: string): void {
    logger.warn("orchestrator.session", "session_error", { session_id: id, error });
    this.db.prepare("UPDATE sessions SET status = 'error', last_error = ?, last_activity = ? WHERE id = ?")
      .run(error, new Date().toISOString(), id);
  }

  setSdkSessionId(id: string, sdkSessionId: string): void {
    logger.debug("orchestrator.session", "sdk_session_id_set", { session_id: id, sdk_session_id: sdkSessionId });
    this.db.prepare("UPDATE sessions SET sdk_session_id = ?, last_activity = ? WHERE id = ?")
      .run(sdkSessionId, new Date().toISOString(), id);
  }

  incrementMessages(id: string): void {
    logger.debug("orchestrator.session", "increment_message_count", { session_id: id });
    this.db.prepare("UPDATE sessions SET message_count = message_count + 1, last_activity = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  addUsage(id: string, usage: Usage): void {
    logger.debug("orchestrator.session", "add_usage", {
      session_id: id,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost_usd: usage.cost_usd,
    });
    this.db.prepare(`
      UPDATE sessions SET
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cost_usd = cost_usd + ?
      WHERE id = ?
    `).run(usage.input_tokens, usage.output_tokens, usage.cost_usd, id);
  }

  updateContextTokens(id: string, tokens: number): void {
    logger.debug("orchestrator.session", "update_context_tokens", { session_id: id, tokens });
    this.db.prepare("UPDATE sessions SET context_tokens = ?, last_activity = ? WHERE id = ?")
      .run(tokens, new Date().toISOString(), id);
  }

  incrementCompactCount(id: string): void {
    logger.info("orchestrator.session", "compact_occurred", { session_id: id });
    this.db.prepare(`
      UPDATE sessions SET
        compact_count = compact_count + 1,
        last_compact_at = ?,
        last_activity = ?
      WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), id);
  }

  remove(id: string): Session | undefined {
    const session = this.get(id);
    logger.info("orchestrator.session", "remove_session", { session_id: id });
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

    logger.info("orchestrator.session", "rename_session", { session_id: id, name });
    this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
    return true;
  }

  /** Check if a session name is already in use. */
  nameExists(name: string): boolean {
    const row = this.db.prepare("SELECT id FROM sessions WHERE name = ?").get(name) as { id: string } | undefined;
    return !!row;
  }

  setPinned(id: string, pinned: boolean): void {
    logger.info("orchestrator.session", "set_pinned", { session_id: id, pinned });
    this.db.prepare("UPDATE sessions SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  /**
   * Capacity-evictable sessions ordered from least-recently-active to most-recently-active.
   * Only ready/idle and not pinned sessions are candidates.
   */
  evictableByLru(): Session[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE status IN ('ready', 'idle') AND pinned = 0
      ORDER BY last_activity ASC
    `).all() as SessionRow[];
    return rows.map((row) => rowToSession(row));
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

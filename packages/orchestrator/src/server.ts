import { Hono } from "hono";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { SessionManager } from "./sessions.js";
import type { ContainerManager } from "./docker.js";
import type { WsBridge } from "./ws-bridge.js";
import type {
  SessionRequest,
  MessageRequest,
  ForkRequest,
  ErrorCode,
  ErrorResponse,
  RunnerEvent,
  Usage,
} from "./types.js";
import type { TokenPool } from "./token-pool.js";
import type { TenantManager, Tenant } from "./tenants.js";
import { createAuthMiddleware } from "./auth.js";
import { getLogContext, logger, runWithLogContext } from "./logger.js";
import type Database from "better-sqlite3";
import { listSnapshots, getSnapshot } from "./db.js";

interface AppContext {
  sessions: SessionManager;
  docker: ContainerManager;
  bridge: WsBridge;
  tokenPool: TokenPool;
  db: Database.Database;
  env: Record<string, string>;
  runnerImage: string;
  network: string;
  sessionsVolume: string;
  sessionsPath: string; // host-side mount path for reading transcripts
  wsPort: number;
  orchestratorWsUrl: string;
  messageTimeoutMs: number;
  maxActiveSessions?: number;
  startedAt: Date;
  warmPool?: import("./warm-pool.js").WarmPool;
  tenants?: TenantManager;
  adminApiKey?: string;
}

export function createServer(ctx: AppContext): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const traceId = c.req.header("x-trace-id") || requestId;
    c.header("x-request-id", requestId);
    c.header("x-trace-id", traceId);

    return runWithLogContext({ requestId, traceId }, async () => {
      await next();
    });
  });

  // --- Auth middleware (when tenants are configured) ---
  if (ctx.tenants) {
    app.use("*", createAuthMiddleware(ctx.tenants, ctx.adminApiKey));
  }

  // Helper: get the current tenant (undefined when auth is disabled)
  function getTenant(c: import("hono").Context): Tenant | undefined {
    if (!ctx.tenants) return undefined;
    try { return c.get("tenant"); } catch { return undefined; }
  }

  // Helper: check if a session belongs to the requesting tenant
  function checkOwnership(c: import("hono").Context, session: { tenantId?: string }): boolean {
    const tenant = getTenant(c);
    if (!tenant) return true; // no auth = allow all
    return session.tenantId === tenant.id;
  }

  // --- Health ---

  app.get("/health", async (c) => {
    const dockerConnected = await ctx.docker.checkConnection();
    logger.debug("orchestrator.api", "health_check", { docker_connected: dockerConnected });
    return c.json({
      status: "ok",
      active_sessions: ctx.sessions.activeCount(),
      token_pool: {
        size: ctx.tokenPool.size,
        usage: ctx.tokenPool.usage(),
      },
      uptime_ms: Date.now() - ctx.startedAt.getTime(),
      runner_image: ctx.runnerImage,
      docker_connected: dockerConnected,
      max_active_sessions: ctx.maxActiveSessions ?? null,
      warm_pool: ctx.warmPool?.stats ?? null,
    });
  });

  // --- Sessions: List ---

  app.get("/sessions", (c) => {
    const tenant = getTenant(c);
    const sessions = ctx.sessions.list(tenant?.id).map((s) => ({
      session_id: s.id,
      name: s.name,
      pinned: s.pinned,
      status: s.status,
      source: {
        type: s.repo ? "repo" as const : s.vaultName ? "vault" as const : s.workspace ? "workspace" as const : "ephemeral" as const,
        ...(s.repo ? { repo: s.repo, branch: s.branch } : {}),
        ...(s.workspace ? { workspace: s.workspace } : {}),
        ...(s.vaultName ? { vault: s.vaultName } : {}),
      },
      model: s.model,
      created_at: s.createdAt.toISOString(),
      last_activity: s.lastActivity.toISOString(),
      message_count: s.messageCount,
    }));
    logger.debug("orchestrator.api", "list_sessions", { count: sessions.length });
    return c.json({ sessions });
  });

  // --- Sessions: Get detail ---

  app.get("/sessions/:id", (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id") });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }
    logger.debug("orchestrator.api", "get_session", { session_id: session.id });

    return c.json({
      session_id: session.id,
      name: session.name,
      pinned: session.pinned,
      status: session.status,
      source: {
        type: session.repo ? "repo" : session.vaultName ? "vault" : session.workspace ? "workspace" : "ephemeral",
        ...(session.repo ? { repo: session.repo, branch: session.branch } : {}),
        ...(session.workspace ? { workspace: session.workspace } : {}),
        ...(session.vaultName ? { vault: session.vaultName } : {}),
      },
      model: session.model,
      created_at: session.createdAt.toISOString(),
      last_activity: session.lastActivity.toISOString(),
      message_count: session.messageCount,
      total_usage: session.totalUsage,
      error: session.lastError,
      container_id: session.containerId,
      sdk_session_id: session.sdkSessionId,
      forked_from: session.forkedFrom,
      context_tokens: session.contextTokens,
      compact_count: session.compactCount,
      last_compact_at: session.lastCompactAt?.toISOString(),
    });
  });

  // --- Sessions: Transcript ---

  app.get("/sessions/:id/transcript", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "transcript" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    // Claude SDK stores transcripts at: <claude-dir>/projects/-workspace/<session-id>.jsonl
    const transcriptPath = join(ctx.sessionsPath, "projects", "-workspace", `${session.id}.jsonl`);

    if (!existsSync(transcriptPath)) {
      logger.debug("orchestrator.api", "transcript_not_found", { session_id: session.id, path: transcriptPath });
      return c.json({ code: "session_not_found", message: "Transcript not yet available" } satisfies ErrorResponse, 404 as any);
    }

    const raw = await readFile(transcriptPath, "utf-8");
    const format = c.req.query("format");

    if (format === "json") {
      const lines = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return c.json({ session_id: session.id, events: lines });
    }

    // Return raw JSONL
    return new Response(raw, {
      headers: { "Content-Type": "application/x-ndjson", "X-Session-Id": session.id },
    });
  });

  // --- Context: Get current context ---

  app.get("/sessions/:id/context", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "busy") return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    try {
      const sent = ctx.bridge.sendContextCommand(session.id, { op: "get_context" }, requestId);
      if (!sent) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);
      const result = await ctx.bridge.waitForContextResult(session.id, requestId);
      if (!result.success) return c.json({ code: "internal", message: result.error || "Context read failed" } satisfies ErrorResponse, 500 as any);

      // Also fetch stats
      const statsId = randomUUID();
      ctx.bridge.sendContextCommand(session.id, { op: "get_stats" }, statsId);
      const statsResult = await ctx.bridge.waitForContextResult(session.id, statsId);

      return c.json({
        session_id: session.id,
        messages: result.data,
        stats: statsResult.success ? statsResult.data : undefined,
        context_tokens: session.contextTokens,
        compact_count: session.compactCount,
        last_compact_at: session.lastCompactAt?.toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator.api", "context_get_error", { session_id: session.id, error: message });
      return c.json({ code: "internal", message } satisfies ErrorResponse, 500 as any);
    }
  });

  // --- Context: Schedule compaction ---

  app.post("/sessions/:id/context/compact", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    let body: { custom_instructions?: string } = {};
    try { body = await c.req.json(); } catch { /* optional body */ }

    const sent = ctx.bridge.sendCompact(session.id, body.custom_instructions);
    if (!sent) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    logger.info("orchestrator.api", "compact_scheduled", { session_id: session.id, has_custom_instructions: Boolean(body.custom_instructions) });
    return c.json({ session_id: session.id, scheduled: true, message: "Compaction will occur on next query" });
  });

  // --- Context: Inject message ---

  app.post("/sessions/:id/context/inject", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "busy") return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    let body: { content: string; role?: "user" | "system"; after_uuid?: string };
    try { body = await c.req.json(); } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }
    if (!body.content) return c.json({ code: "invalid_request", message: "Missing required field: content" } satisfies ErrorResponse, 400 as any);

    try {
      const sent = ctx.bridge.sendContextCommand(session.id, {
        op: "inject_message",
        content: body.content,
        role: body.role ?? "user",
        after_uuid: body.after_uuid,
      }, requestId);
      if (!sent) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

      const result = await ctx.bridge.waitForContextResult(session.id, requestId);
      if (!result.success) return c.json({ code: "internal", message: result.error || "Inject failed" } satisfies ErrorResponse, 500 as any);
      return c.json({ session_id: session.id, ...(result.data as any) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator.api", "context_inject_error", { session_id: session.id, error: message });
      return c.json({ code: "internal", message } satisfies ErrorResponse, 500 as any);
    }
  });

  // --- Context: Remove message ---

  app.delete("/sessions/:id/context/messages/:uuid", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "busy") return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    try {
      const messageUuid = c.req.param("uuid");
      const sent = ctx.bridge.sendContextCommand(session.id, { op: "remove_message", uuid: messageUuid }, requestId);
      if (!sent) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

      const result = await ctx.bridge.waitForContextResult(session.id, requestId);
      if (!result.success) return c.json({ code: "internal", message: result.error || "Remove failed" } satisfies ErrorResponse, 500 as any);
      return c.json({ session_id: session.id, removed_uuid: messageUuid });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator.api", "context_remove_error", { session_id: session.id, error: message });
      return c.json({ code: "internal", message } satisfies ErrorResponse, 500 as any);
    }
  });

  // --- Context: Truncate ---

  app.post("/sessions/:id/context/truncate", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "busy") return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    let body: { keep_last_n: number };
    try { body = await c.req.json(); } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }
    if (typeof body.keep_last_n !== "number" || body.keep_last_n < 1) {
      return c.json({ code: "invalid_request", message: "keep_last_n must be a positive number" } satisfies ErrorResponse, 400 as any);
    }

    try {
      const sent = ctx.bridge.sendContextCommand(session.id, { op: "truncate", keep_last_n: body.keep_last_n }, requestId);
      if (!sent) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

      const result = await ctx.bridge.waitForContextResult(session.id, requestId);
      if (!result.success) return c.json({ code: "internal", message: result.error || "Truncate failed" } satisfies ErrorResponse, 500 as any);
      return c.json({ session_id: session.id, truncated: true, kept_turns: body.keep_last_n });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator.api", "context_truncate_error", { session_id: session.id, error: message });
      return c.json({ code: "internal", message } satisfies ErrorResponse, 500 as any);
    }
  });

  // --- Context: Steer (abort + edit + resume) ---

  app.post("/sessions/:id/context/steer", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const traceId = c.req.header("x-trace-id") || requestId;
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    let body: {
      message: string;
      mode?: "steer" | "fork_and_steer";
      model?: string;
      maxTurns?: number;
      compact?: boolean;
      compact_instructions?: string;
      operations?: any[];
    };
    try { body = await c.req.json(); } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }
    if (!body.message) {
      return c.json({ code: "invalid_request", message: "Missing required field: message" } satisfies ErrorResponse, 400 as any);
    }

    const mode = body.mode || "steer";

    let sent: boolean;
    if (mode === "fork_and_steer") {
      sent = ctx.bridge.sendForkAndSteer(session.id, body.message, {
        model: body.model,
        maxTurns: body.maxTurns,
        requestId,
        traceId,
      });
    } else {
      sent = ctx.bridge.sendSteer(session.id, body.message, {
        model: body.model,
        maxTurns: body.maxTurns,
        compact: body.compact,
        compactInstructions: body.compact_instructions,
        operations: body.operations,
        requestId,
        traceId,
      });
    }
    if (!sent) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    logger.info("orchestrator.api", `${mode}_sent`, {
      session_id: session.id,
      was_busy: session.status === "busy",
      operations_count: body.operations?.length ?? 0,
      request_id: requestId,
    });

    return c.json({ session_id: session.id, steered: true, mode, was_busy: session.status === "busy" });
  });

  // --- Snapshots ---

  app.get("/sessions/:id/snapshots", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);

    const rows = listSnapshots(ctx.db, session.id);
    const snapshots = rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      request_id: r.request_id ?? undefined,
      trigger: r.trigger,
      message_count: r.message_count,
      roles: r.roles ? JSON.parse(r.roles) : [],
      created_at: r.created_at,
    }));

    return c.json({ snapshots });
  });

  app.get("/sessions/:id/snapshots/:snapId", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);

    const snapId = parseInt(c.req.param("snapId"), 10);
    if (isNaN(snapId)) return c.json({ code: "invalid_request", message: "Invalid snapshot ID" } satisfies ErrorResponse, 400 as any);

    const row = getSnapshot(ctx.db, snapId);
    if (!row || row.session_id !== session.id) {
      return c.json({ code: "session_not_found", message: "Snapshot not found" } satisfies ErrorResponse, 404 as any);
    }

    return c.json({
      id: row.id,
      session_id: row.session_id,
      request_id: row.request_id ?? undefined,
      trigger: row.trigger,
      message_count: row.message_count,
      roles: row.roles ? JSON.parse(row.roles) : [],
      messages: JSON.parse(row.messages),
      created_at: row.created_at,
    });
  });

  app.post("/sessions/:id/snapshots", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    // Request a manual snapshot from the runner via context command
    const requestId = randomUUID();
    const sent = ctx.bridge.sendContextCommand(session.id, { op: "get_context" }, requestId);
    if (!sent) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    try {
      const result = await ctx.bridge.waitForContextResult(session.id, requestId, 30_000);
      if (!result.success || !result.data) {
        return c.json({ code: "internal", message: result.error || "Failed to get context" } satisfies ErrorResponse, 500 as any);
      }

      const messages = result.data as any[];
      const roles = messages.map((m: any) => m.role || m.type || "unknown");
      const { insertSnapshot: insertSnap } = await import("./db.js");
      const snapId = insertSnap(ctx.db, session.id, "manual", messages.length, roles, messages, requestId);

      return c.json({
        id: snapId,
        session_id: session.id,
        trigger: "manual",
        message_count: messages.length,
        roles,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      return c.json({ code: "timeout", message: "Timed out waiting for context data" } satisfies ErrorResponse, 504 as any);
    }
  });

  // --- Sessions: Rename ---

  app.patch("/sessions/:id", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "rename" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    let body: { name?: string; pinned?: boolean };
    try {
      body = (await c.req.json()) as { name?: string; pinned?: boolean };
    } catch {
      logger.warn("orchestrator.api", "invalid_json", { session_id: session.id, endpoint: "/sessions/:id" });
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }

    if (body.name === undefined && body.pinned === undefined) {
      logger.warn("orchestrator.api", "invalid_session_update", { session_id: session.id });
      return c.json({ code: "invalid_request", message: "Must provide at least one field: name or pinned" } satisfies ErrorResponse, 400 as any);
    }

    let name = session.name;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        logger.warn("orchestrator.api", "invalid_session_name", { session_id: session.id });
        return c.json({ code: "invalid_request", message: "Missing or empty required field: name" } satisfies ErrorResponse, 400 as any);
      }
      name = body.name.trim();
      const ok = ctx.sessions.rename(session.id, name);
      if (!ok) {
        logger.warn("orchestrator.api", "rename_conflict", { session_id: session.id, name });
        return c.json({ code: "invalid_request", message: `Session name "${name}" is already in use` } satisfies ErrorResponse, 409 as any);
      }
    }

    let pinned = session.pinned;
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== "boolean") {
        logger.warn("orchestrator.api", "invalid_pinned_type", { session_id: session.id });
        return c.json({ code: "invalid_request", message: "Field pinned must be a boolean" } satisfies ErrorResponse, 400 as any);
      }
      pinned = body.pinned;
      ctx.sessions.setPinned(session.id, pinned);
    }

    logger.info("orchestrator.api", "session_updated", { session_id: session.id });
    return c.json({ session_id: session.id, name, pinned });
  });

  // --- Sessions: Delete ---

  app.delete("/sessions/:id", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "delete" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }
    logger.info("orchestrator.api", "delete_session_request", { session_id: session.id });

    ctx.bridge.sendShutdown(session.id);
    await ctx.docker.kill(session.id);
    ctx.sessions.updateStatus(session.id, "stopped");

    // Note: vault data lives on the shared vaults volume, not a per-session volume.
    // Use DELETE /vaults/:name to stop the persistent sidecar if needed.

    const result = {
      session_id: session.id,
      status: "stopped" as const,
      total_usage: session.totalUsage,
    };

    ctx.sessions.remove(session.id);
    ctx.tokenPool.release(session.id);
    return c.json(result);
  });

  // --- Sessions: Fork ---

  app.post("/sessions/:id/fork", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const parent = ctx.sessions.get(c.req.param("id"));
    if (!parent) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "fork" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    if (!parent.sdkSessionId) {
      logger.warn("orchestrator.api", "fork_without_sdk_session_id", { session_id: parent.id });
      return c.json({ code: "invalid_request", message: "Cannot fork: parent session has no SDK session ID (has it processed a message yet?)" } satisfies ErrorResponse, 400 as any);
    }

    let body: ForkRequest;
    try {
      body = (await c.req.json()) as ForkRequest;
    } catch {
      body = {};
    }
    if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
      logger.warn("orchestrator.api", "invalid_pinned_payload", { session_id: parent.id, pinned: body.pinned });
      return c.json({ code: "invalid_request", message: "Field pinned must be a boolean" } satisfies ErrorResponse, 400 as any);
    }

    const sessionId = randomUUID();
    const model = body.model || parent.model;
    let startupComplete = false;

    try {
      logger.info("orchestrator.api", "fork_session_request", {
        parent_session_id: parent.id,
        include_system_prompt: Boolean(body.systemPrompt || parent.systemPrompt),
        request_id: requestId,
      });
      await ensureCapacity(ctx);

      // Assign an OAuth token from the pool
      const { token, tokenIndex } = ctx.tokenPool.assign(sessionId);
      const sessionEnv = { ...ctx.env, CLAUDE_CODE_OAUTH_TOKEN: token };

      const containerId = await ctx.docker.spawn({
        sessionId,
        image: ctx.runnerImage,
        orchestratorUrl: ctx.orchestratorWsUrl,
        env: sessionEnv,
        network: ctx.network,
        sessionsVolume: ctx.sessionsVolume,
        repo: parent.repo,
        branch: parent.branch,
        workspace: parent.workspace,
        model,
        systemPrompt: body.systemPrompt || parent.systemPrompt,
        appendSystemPrompt: body.appendSystemPrompt,
        maxTurns: body.maxTurns ?? parent.maxTurns,
        forkFrom: parent.sdkSessionId,
        forkAt: body.resumeAt,
        forkSession: true,
      });

      ctx.sessions.create(sessionId, containerId, tokenIndex, {
        repo: parent.repo,
        branch: parent.branch,
        workspace: parent.workspace,
        model,
        pinned: body.pinned ?? parent.pinned,
        systemPrompt: body.systemPrompt || parent.systemPrompt,
        maxTurns: body.maxTurns ?? parent.maxTurns,
        forkedFrom: parent.id,
        tenantId: parent.tenantId,
      });

      logger.info("orchestrator.api", "fork_session_created", {
        session_id: sessionId,
        parent_session_id: parent.id,
        forked_from: parent.id,
        request_id: requestId,
      });

      await waitForReady(ctx, sessionId, undefined, requestId);
      startupComplete = true;
      logger.info("orchestrator.api", "fork_session_ready", { session_id: sessionId, request_id: requestId });

      // If a message was provided, send it immediately
      if (body.message) {
        logger.debug("orchestrator.api", "fork_session_message_present", {
          session_id: sessionId,
          parent_session_id: parent.id,
          message_len: body.message.length,
        });
        ctx.sessions.incrementMessages(sessionId);
        const result = await sendAndCollect(ctx, sessionId, body.message, {
          model,
          maxTurns: body.maxTurns,
          requestId,
        });
        return c.json({
          session_id: sessionId,
          forked_from: parent.id,
          result: result.text,
          usage: result.usage,
        });
      }

      return c.json({ session_id: sessionId, status: "ready", forked_from: parent.id });
    } catch (err) {
      if (isApiError(err)) {
        logger.warn("orchestrator.api", "fork_session_api_error", { session_id: sessionId, code: err.code, request_id: requestId });
        return c.json({ code: err.code, message: err.message, session_id: sessionId }, err.status as any);
      }
      if (!startupComplete) {
        await rollbackSession(ctx, sessionId, requestId);
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = categorizeError(message) as any;
      logger.error("orchestrator.api", "fork_session_error", { session_id: sessionId, code, message, request_id: requestId });
      return c.json({ code, message, session_id: sessionId }, 500 as any);
    }
  });

  // --- Sessions: Create + Run (blocking) ---

  app.post("/sessions", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const tenant = getTenant(c);
    const body = await parseSessionRequest(c, ctx.sessions, tenant?.id);
    if ("error" in body) {
      logger.warn("orchestrator.api", "invalid_create_session_request", { error: body.error });
      return c.json(body.error, body.status);
    }

    const sessionId = randomUUID();
    let startupComplete = false;
    logger.info("orchestrator.api", "create_session_request", {
      session_id: sessionId,
      source: body.repo ? "repo" : body.vault ? "vault" : body.workspace ? "workspace" : "ephemeral",
      pinned: body.pinned,
      vault: body.vault,
      request_id: requestId,
    });

    try {
      await ensureCapacity(ctx);
      await spawnSession(ctx, sessionId, body, requestId, tenant?.id);
      await waitForReady(ctx, sessionId, undefined, requestId);
      startupComplete = true;
      logger.info("orchestrator.api", "session_ready", { session_id: sessionId, request_id: requestId });

      // If no message, just return the ready session
      if (!body.message) {
        return c.json({ session_id: sessionId, status: "ready" });
      }

      logger.debug("orchestrator.api", "create_session_message_present", {
        session_id: sessionId,
        message_len: body.message.length,
        model: body.model,
      });
      ctx.sessions.incrementMessages(sessionId);

      const result = await sendAndCollect(ctx, sessionId, body.message!, {
        model: body.model,
        maxTurns: body.maxTurns,
        requestId,
      });

      return c.json({
        session_id: sessionId,
        result: result.text,
        usage: result.usage,
      });
    } catch (err) {
      if (isApiError(err)) {
        logger.warn("orchestrator.api", "create_session_api_error", { session_id: sessionId, code: err.code, request_id: requestId });
        return c.json({ code: err.code, message: err.message, session_id: sessionId }, err.status as any);
      }
      if (!startupComplete) {
        await rollbackSession(ctx, sessionId, requestId);
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = categorizeError(message) as any;
      logger.error("orchestrator.api", "create_session_error", { session_id: sessionId, code, message, request_id: requestId });
      return c.json({ code, message, session_id: sessionId }, 500 as any);
    }
  });

  // --- Messages: Follow-up (blocking) ---

  app.post("/sessions/:id/messages", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "messages" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }
    if (session.status === "busy") {
      logger.warn("orchestrator.api", "session_busy", { session_id: session.id });
      return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    }
    if (session.status === "stopped" || session.status === "error") {
      logger.warn("orchestrator.api", "session_stopped", { session_id: session.id, status: session.status });
      return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    }

    let body: MessageRequest;
    try {
      body = (await c.req.json()) as MessageRequest;
    } catch {
      logger.warn("orchestrator.api", "invalid_json", { session_id: session.id, endpoint: "/sessions/:id/messages" });
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }

    if (!body.message) {
      logger.warn("orchestrator.api", "message_missing", { session_id: session.id });
      return c.json({ code: "invalid_request", message: "Missing required field: message" } satisfies ErrorResponse, 400 as any);
    }

    try {
      logger.info("orchestrator.api", "send_message", {
        session_id: session.id,
        message_len: body.message.length,
        model: body.model,
        request_id: requestId,
      });
      ctx.sessions.incrementMessages(session.id);
      const result = await sendAndCollect(ctx, session.id, body.message, {
        model: body.model,
        maxTurns: body.maxTurns,
        requestId,
      });

      return c.json({ result: result.text, usage: result.usage });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator.api", "send_message_error", { session_id: session.id, message });
      return c.json({ code: "agent_error", message } satisfies ErrorResponse, 500 as any);
    }
  });

  // --- Tenants CRUD (admin-only when auth is enabled) ---

  if (ctx.tenants) {
    const tenantMgr = ctx.tenants;

    app.get("/tenants", (c) => {
      // Admin sees all tenants; non-admin tenant sees only self
      const tenant = getTenant(c);
      if (tenant) {
        return c.json({ tenants: [{ id: tenant.id, name: tenant.name, namespace: tenant.namespace, max_sessions: tenant.maxSessions, created_at: tenant.createdAt.toISOString() }] });
      }
      const all = tenantMgr.list().map((t) => ({
        id: t.id,
        name: t.name,
        namespace: t.namespace,
        max_sessions: t.maxSessions,
        created_at: t.createdAt.toISOString(),
        updated_at: t.updatedAt.toISOString(),
      }));
      return c.json({ tenants: all });
    });

    app.get("/tenants/:id", (c) => {
      const tenant = getTenant(c);
      const id = c.req.param("id");
      if (tenant && tenant.id !== id) {
        return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
      }
      const t = tenantMgr.get(id);
      if (!t) return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
      return c.json({
        id: t.id,
        name: t.name,
        namespace: t.namespace,
        max_sessions: t.maxSessions,
        vault: t.vault,
        has_obsidian_auth: !!t.obsidianAuthToken,
        has_git_token: !!t.gitToken,
        created_at: t.createdAt.toISOString(),
        updated_at: t.updatedAt.toISOString(),
      });
    });

    app.post("/tenants", async (c) => {
      // Admin only (enforced by auth middleware — non-admin tenant gets 401)
      const tenant = getTenant(c);
      if (tenant) {
        return c.json({ code: "invalid_request", message: "Only admin can create tenants" } satisfies ErrorResponse, 403 as any);
      }

      let body: any;
      try { body = await c.req.json(); } catch {
        return c.json({ code: "invalid_request", message: "Invalid JSON" } satisfies ErrorResponse, 400 as any);
      }

      if (!body.id || !body.name) {
        return c.json({ code: "invalid_request", message: "Fields id and name are required" } satisfies ErrorResponse, 400 as any);
      }

      try {
        const { tenant: created, apiKey } = tenantMgr.create({
          id: body.id,
          name: body.name,
          namespace: body.namespace,
          maxSessions: body.max_sessions,
          vault: body.vault,
          obsidianAuthToken: body.obsidian_auth_token,
          obsidianE2eePassword: body.obsidian_e2ee_password,
          gitToken: body.git_token,
        });

        return c.json({
          id: created.id,
          name: created.name,
          namespace: created.namespace,
          api_key: apiKey, // shown once
          max_sessions: created.maxSessions,
        }, 201 as any);
      } catch (err: any) {
        if (err?.message?.includes("UNIQUE constraint")) {
          return c.json({ code: "invalid_request", message: "Tenant ID or namespace already exists" } satisfies ErrorResponse, 409 as any);
        }
        throw err;
      }
    });

    app.patch("/tenants/:id", async (c) => {
      const tenant = getTenant(c);
      if (tenant) {
        return c.json({ code: "invalid_request", message: "Only admin can update tenants" } satisfies ErrorResponse, 403 as any);
      }

      let body: any;
      try { body = await c.req.json(); } catch {
        return c.json({ code: "invalid_request", message: "Invalid JSON" } satisfies ErrorResponse, 400 as any);
      }

      const updated = tenantMgr.update(c.req.param("id"), {
        name: body.name,
        maxSessions: body.max_sessions,
        vault: body.vault,
        obsidianAuthToken: body.obsidian_auth_token,
        obsidianE2eePassword: body.obsidian_e2ee_password,
        gitToken: body.git_token,
      });

      if (!updated) return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
      return c.json({ id: updated.id, name: updated.name, max_sessions: updated.maxSessions });
    });

    app.post("/tenants/:id/rotate-key", (c) => {
      const tenant = getTenant(c);
      if (tenant) {
        return c.json({ code: "invalid_request", message: "Only admin can rotate keys" } satisfies ErrorResponse, 403 as any);
      }

      const newKey = tenantMgr.rotateApiKey(c.req.param("id"));
      if (!newKey) return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
      return c.json({ id: c.req.param("id"), api_key: newKey });
    });

    app.delete("/tenants/:id", (c) => {
      const tenant = getTenant(c);
      if (tenant) {
        return c.json({ code: "invalid_request", message: "Only admin can delete tenants" } satisfies ErrorResponse, 403 as any);
      }

      const deleted = tenantMgr.delete(c.req.param("id"));
      if (!deleted) return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
      return c.json({ deleted: true });
    });
  }

  return app;
}

// --- Helpers ---

async function parseSessionRequest(c: any, sessions?: SessionManager, tenantId?: string): Promise<SessionRequest | { error: ErrorResponse; status: any }> {
  let body: SessionRequest;
  try {
    body = (await c.req.json()) as SessionRequest;
  } catch {
    logger.warn("orchestrator.api", "invalid_json", { endpoint: "parseSessionRequest" });
    return { error: { code: "invalid_request", message: "Invalid JSON body" }, status: 400 };
  }

  // repo and workspace are both optional — omitting both launches an ephemeral session
  // with an empty /workspace directory inside the container.

  if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
    logger.warn("orchestrator.api", "invalid_pinned_payload", { pinned: body.pinned });
    return { error: { code: "invalid_request", message: "Field pinned must be a boolean" }, status: 400 };
  }

  if (body.name && sessions?.nameExists(body.name.trim(), tenantId)) {
    logger.warn("orchestrator.api", "duplicate_session_name", { name: body.name.trim() });
    return { error: { code: "invalid_request", message: `Session name "${body.name.trim()}" is already in use` }, status: 409 };
  }

  return body;
}

async function spawnSession(ctx: AppContext, sessionId: string, body: SessionRequest, requestId?: string, tenantId?: string) {
  const model = body.model || "sonnet";
  const maxTurns = body.maxTurns;
  logger.info("orchestrator.session", "spawn_session", {
    session_id: sessionId,
    model,
    repo: body.repo,
    workspace: body.workspace,
    vault: body.vault,
    branch: body.branch,
    request_id: requestId,
  });

  // Try warm pool adoption (only for sessions without workspace/additionalDirectories bind mounts).
  // Vault sessions CAN use warm pool since all warm containers mount the shared vaults volume.
  const canUseWarmPool = ctx.warmPool && !body.workspace && !body.additionalDirectories?.length;
  if (canUseWarmPool) {
    const warmEntry = ctx.warmPool!.adopt();
    if (warmEntry) {
      // Release warm container's token and assign a fresh one for the real session
      ctx.tokenPool.release(warmEntry.warmId);
      const { token, tokenIndex } = ctx.tokenPool.assign(sessionId);

      // Send adopt command with real session config
      const adoptConfig = {
        repo: body.repo,
        branch: body.branch,
        gitToken: ctx.env.GIT_TOKEN || ctx.env.GITHUB_TOKEN,
        vault: body.vault,
        model,
        systemPrompt: body.systemPrompt,
        appendSystemPrompt: body.appendSystemPrompt,
        maxTurns,
        thinking: body.thinking,
        allowedTools: body.allowedTools,
        disallowedTools: body.disallowedTools,
        compactInstructions: body.compactInstructions,
        permissionMode: body.permissionMode,
        mcpServers: body.mcpServers,
        allowedPaths: body.allowedPaths,
      };

      ctx.bridge.sendAdopt(warmEntry.warmId, sessionId, token, adoptConfig);
      ctx.bridge.rekeyConnection(warmEntry.warmId, sessionId);
      ctx.docker.rekeySession(warmEntry.warmId, sessionId);

      const session = ctx.sessions.create(sessionId, warmEntry.containerId, tokenIndex, {
        name: body.name?.trim(),
        pinned: body.pinned,
        repo: body.repo,
        branch: body.branch,
        workspace: body.workspace,
        vaultName: body.vault,
        model,
        systemPrompt: body.systemPrompt,
        maxTurns,
        tenantId,
      });

      logger.info("orchestrator.session", "session_adopted_from_warm_pool", {
        session_id: sessionId,
        warm_id: warmEntry.warmId,
        request_id: requestId,
      });
      return { session, containerId: warmEntry.containerId };
    }
  }

  // Cold path: spawn a new container
  // Assign an OAuth token from the pool for this session
  const { token, tokenIndex } = ctx.tokenPool.assign(sessionId);
  const sessionEnv = { ...ctx.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  let containerId: string | undefined;

  try {
    // Vault sync is handled by the runner itself (ob sync-setup + ob sync).
    // The runner receives RUNNER_VAULT env var and OBSIDIAN_AUTH_TOKEN via FORWARDED_RUNNER_ENV_KEYS.

    containerId = await ctx.docker.spawn({
      sessionId,
      image: ctx.runnerImage,
      orchestratorUrl: ctx.orchestratorWsUrl,
      env: sessionEnv,
      network: ctx.network,
      sessionsVolume: ctx.sessionsVolume,
      vault: body.vault,
      repo: body.repo,
      branch: body.branch,
      workspace: body.workspace,
      model,
      systemPrompt: body.systemPrompt,
      appendSystemPrompt: body.appendSystemPrompt,
      maxTurns,
      thinking: body.thinking,
      allowedTools: body.allowedTools,
      disallowedTools: body.disallowedTools,
      additionalDirectories: body.additionalDirectories,
      compactInstructions: body.compactInstructions,
      permissionMode: body.permissionMode,
      mcpServers: body.mcpServers,
      allowedPaths: body.allowedPaths,
    });

    const session = ctx.sessions.create(sessionId, containerId, tokenIndex, {
      name: body.name?.trim(),
      pinned: body.pinned,
      repo: body.repo,
      branch: body.branch,
      workspace: body.workspace,
      vaultName: body.vault,
      model,
      systemPrompt: body.systemPrompt,
      maxTurns,
      tenantId,
    });

    logger.debug("orchestrator.session", "session_db_record_created", { session_id: sessionId, request_id: requestId });
    return { session, containerId };
  } catch (err) {
    logger.error("orchestrator.session", "spawn_session_failed", {
      session_id: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (containerId) {
      await ctx.docker.kill(sessionId).catch(() => undefined);
    }
    ctx.tokenPool.release(sessionId);
    throw err;
  }
}

function waitForReady(ctx: AppContext, sessionId: string, timeoutMs = 120_000, requestId?: string): Promise<void> {
  // Check if already ready (handles race where status arrived before we listen)
  const session = ctx.sessions.get(sessionId);
  if (session?.status === "ready") return Promise.resolve();
  logger.debug("orchestrator.session", "wait_for_ready", {
    session_id: sessionId,
    timeout_ms: timeoutMs,
    request_id: requestId,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logger.warn("orchestrator.session", "wait_for_ready_timeout", {
        session_id: sessionId,
        request_id: requestId,
      });
      cleanup();
      reject(new Error("Timed out waiting for runner to be ready"));
    }, timeoutMs);

    const onStatus = (status: string) => {
      logger.debug("orchestrator.session", "wait_for_ready_status", { session_id: sessionId, status, request_id: requestId });
      if (status === "ready") { cleanup(); resolve(); }
    };
    const onError = (_code: string, message: string) => {
      logger.warn("orchestrator.session", "wait_for_ready_error", { session_id: sessionId, code: _code, message, request_id: requestId });
      cleanup();
      reject(new Error(message));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ctx.bridge.removeListener(`status:${sessionId}`, onStatus);
      ctx.bridge.removeListener(`error:${sessionId}`, onError);
    };

    ctx.bridge.on(`status:${sessionId}`, onStatus);
    ctx.bridge.on(`error:${sessionId}`, onError);
  });
}

function sendAndCollect(
  ctx: AppContext,
  sessionId: string,
  message: string,
  overrides?: { model?: string; maxTurns?: number; requestId?: string }
): Promise<{ text: string; usage: Usage }> {
  logger.debug("orchestrator.session", "send_and_collect", {
    session_id: sessionId,
    model: overrides?.model,
    max_turns: overrides?.maxTurns,
    message_len: message.length,
    request_id: overrides?.requestId,
  });
  return new Promise((resolve, reject) => {
    let text = "";
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 };
    const requestId = overrides?.requestId;
    const traceId = getLogContext()?.traceId;
    const timeout = setTimeout(() => {
      logger.warn("orchestrator.session", "send_and_collect_timeout", {
        session_id: sessionId,
        timeout_ms: ctx.messageTimeoutMs,
        request_id: requestId,
      });
      cleanup();
      reject(new Error(`Timed out waiting for runner result after ${ctx.messageTimeoutMs}ms`));
    }, ctx.messageTimeoutMs);

    const onEvent = (event: RunnerEvent) => {
      if (event.type === "assistant") {
        // content is now an array of blocks; extract text parts
        const blocks = Array.isArray(event.content) ? event.content : [];
        text += blocks
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
      } else if (event.type === "result") {
        cleanup();
        usage.input_tokens = event.usage?.input_tokens || 0;
        usage.output_tokens = event.usage?.output_tokens || 0;
        usage.cost_usd = event.usage?.cost_usd || 0;
        usage.duration_ms = event.usage?.duration_ms || 0;
        ctx.sessions.addUsage(sessionId, usage);
        if (event.subtype === "success") {
          logger.info("orchestrator.session", "send_and_collect_result", {
            session_id: sessionId,
            usage,
            request_id: requestId,
          });
          resolve({ text: event.result || text, usage });
        } else {
          logger.warn("orchestrator.session", "send_and_collect_result_error", {
            session_id: sessionId,
            subtype: event.subtype,
            errors: event.errors,
            request_id: requestId,
          });
          reject(new Error(event.errors?.join(", ") || "Agent execution failed"));
        }
      }
    };
    const onError = (_code: string, message: string) => {
      logger.warn("orchestrator.session", "send_and_collect_error", { session_id: sessionId, code: _code, message, request_id: requestId });
      cleanup();
      reject(new Error(message));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ctx.bridge.removeListener(`event:${sessionId}`, onEvent);
      ctx.bridge.removeListener(`error:${sessionId}`, onError);
    };

    ctx.bridge.on(`event:${sessionId}`, onEvent);
    ctx.bridge.on(`error:${sessionId}`, onError);

    const sent = ctx.bridge.sendMessage(sessionId, message, {
      ...overrides,
      requestId,
      traceId,
    });
    if (!sent) {
      cleanup();
      reject(new Error("Runner not connected"));
    }
  });
}

function categorizeError(message: string): string {
  if (message.includes("clone") || message.includes("git") || message.includes("Authentication")) return "clone_failed";
  if (message.includes("container") || message.includes("Container")) return "container_failed";
  if (message.includes("timeout") || message.includes("Timed out")) return "timeout";
  return "internal";
}

async function rollbackSession(ctx: AppContext, sessionId: string, requestId?: string): Promise<void> {
  logger.warn("orchestrator.session", "rollback_session", { session_id: sessionId, request_id: requestId });
  ctx.bridge.sendShutdown(sessionId);
  await ctx.docker.kill(sessionId).catch(() => undefined);
  ctx.sessions.remove(sessionId);
  ctx.tokenPool.release(sessionId);
}

interface ApiError extends Error {
  code: ErrorCode;
  status: number;
}

function createApiError(code: ErrorCode, status: number, message: string): ApiError {
  const err = new Error(message) as ApiError;
  err.code = code;
  err.status = status;
  return err;
}

function isApiError(err: unknown): err is ApiError {
  if (!(err instanceof Error)) return false;
  const maybe = err as Partial<ApiError>;
  return typeof maybe.code === "string" && typeof maybe.status === "number";
}

async function stopSessionForCapacity(ctx: AppContext, sessionId: string): Promise<void> {
  logger.info("orchestrator.capacity", "evicting_session", { session_id: sessionId });
  ctx.bridge.sendShutdown(sessionId);
  await ctx.docker.kill(sessionId).catch(() => undefined);
  ctx.sessions.updateStatus(sessionId, "stopped");
  ctx.tokenPool.release(sessionId);
}

async function ensureCapacity(ctx: AppContext): Promise<void> {
  if (!ctx.maxActiveSessions) return;

  let active = ctx.sessions.activeCount();
  if (active < ctx.maxActiveSessions) return;
  logger.warn("orchestrator.capacity", "max_active_sessions_reached", {
    active_sessions: active,
    max_active_sessions: ctx.maxActiveSessions,
  });

  const evictable = ctx.sessions.evictableByLru();
  logger.debug("orchestrator.capacity", "evictable_sessions", { count: evictable.length });

  for (const session of evictable) {
    if (active < ctx.maxActiveSessions) break;
    logger.debug("orchestrator.capacity", "evicting_next_session", {
      session_id: session.id,
      last_activity: session.lastActivity.toISOString(),
    });
    await stopSessionForCapacity(ctx, session.id);
    active = ctx.sessions.activeCount();
  }

  if (active >= ctx.maxActiveSessions) {
    logger.error("orchestrator.capacity", "capacity_critical", {
      active_sessions: active,
      max_active_sessions: ctx.maxActiveSessions,
      evictable_count: evictable.length,
    });
    throw createApiError(
      "session_capacity_reached",
      429,
      `Max active sessions (${ctx.maxActiveSessions}) reached; no evictable ready/idle sessions available`,
    );
  }
}

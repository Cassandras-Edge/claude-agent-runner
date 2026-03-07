import { randomUUID } from "crypto";
import type { Hono } from "hono";
import { getSnapshot, insertSnapshot, listSnapshots } from "../../db.js";
import { logger } from "../../logger.js";
import type { ErrorResponse } from "../../types.js";
import type { AppContext } from "../app-context.js";

export function registerContextRoutes(app: Hono, ctx: AppContext): void {
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

  app.post("/sessions/:id/context/compact", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    let body: { custom_instructions?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // optional body
    }

    const sent = ctx.bridge.sendCompact(session.id, body.custom_instructions);
    if (!sent) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    logger.info("orchestrator.api", "compact_scheduled", { session_id: session.id, has_custom_instructions: Boolean(body.custom_instructions) });
    return c.json({ session_id: session.id, scheduled: true, message: "Compaction will occur on next query" });
  });

  app.post("/sessions/:id/context/inject", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "busy") return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    let body: { content: string; role?: "user" | "system"; after_uuid?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }
    if (!body.content) return c.json({ code: "invalid_request", message: "Missing required field: content" } satisfies ErrorResponse, 400 as any);

    try {
      const sent = ctx.bridge.sendContextCommand(
        session.id,
        {
          op: "inject_message",
          content: body.content,
          role: body.role ?? "user",
          after_uuid: body.after_uuid,
        },
        requestId,
      );
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

  app.post("/sessions/:id/context/truncate", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "busy") return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    if (session.status === "stopped" || session.status === "error") return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    if (!ctx.bridge.isConnected(session.id)) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    let body: { keep_last_n: number };
    try {
      body = await c.req.json();
    } catch {
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
    try {
      body = await c.req.json();
    } catch {
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

  app.get("/sessions/:id/snapshots", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);

    const rows = listSnapshots(ctx.db, session.id);
    const snapshots = rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      request_id: row.request_id ?? undefined,
      trigger: row.trigger,
      message_count: row.message_count,
      roles: row.roles ? JSON.parse(row.roles) : [],
      created_at: row.created_at,
    }));

    return c.json({ snapshots });
  });

  app.get("/sessions/:id/snapshots/:snapId", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);

    const snapId = parseInt(c.req.param("snapId"), 10);
    if (Number.isNaN(snapId)) return c.json({ code: "invalid_request", message: "Invalid snapshot ID" } satisfies ErrorResponse, 400 as any);

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

    const requestId = randomUUID();
    const sent = ctx.bridge.sendContextCommand(session.id, { op: "get_context" }, requestId);
    if (!sent) return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 503 as any);

    try {
      const result = await ctx.bridge.waitForContextResult(session.id, requestId, 30_000);
      if (!result.success || !result.data) {
        return c.json({ code: "internal", message: result.error || "Failed to get context" } satisfies ErrorResponse, 500 as any);
      }

      const messages = result.data as any[];
      const roles = messages.map((message: any) => message.role || message.type || "unknown");
      const snapId = insertSnapshot(ctx.db, session.id, "manual", messages.length, roles, messages, requestId);

      return c.json({
        id: snapId,
        session_id: session.id,
        trigger: "manual",
        message_count: messages.length,
        roles,
        created_at: new Date().toISOString(),
      });
    } catch {
      return c.json({ code: "timeout", message: "Timed out waiting for context data" } satisfies ErrorResponse, 504 as any);
    }
  });
}

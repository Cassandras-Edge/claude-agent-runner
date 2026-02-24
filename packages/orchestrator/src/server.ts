import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { SessionManager } from "./sessions.js";
import type { DockerManager } from "./docker.js";
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
import { logger } from "./logger.js";

interface AppContext {
  sessions: SessionManager;
  docker: DockerManager;
  bridge: WsBridge;
  tokenPool: TokenPool;
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
}

export function createServer(ctx: AppContext): Hono {
  const app = new Hono();

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
    });
  });

  // --- Sessions: List ---

  app.get("/sessions", (c) => {
    const sessions = ctx.sessions.list().map((s) => ({
      session_id: s.id,
      name: s.name,
      pinned: s.pinned,
      status: s.status,
      source: {
        type: s.repo ? "repo" as const : "workspace" as const,
        ...(s.repo ? { repo: s.repo, branch: s.branch } : {}),
        ...(s.workspace ? { workspace: s.workspace } : {}),
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
        type: session.repo ? "repo" : "workspace",
        ...(session.repo ? { repo: session.repo, branch: session.branch } : {}),
        ...(session.workspace ? { workspace: session.workspace } : {}),
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
      });

      logger.info("orchestrator.api", "fork_session_created", {
        session_id: sessionId,
        parent_session_id: parent.id,
        forked_from: session.forkedFrom,
      });

      await waitForReady(ctx, sessionId);
      startupComplete = true;
      logger.info("orchestrator.api", "fork_session_ready", { session_id: sessionId });

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
        logger.warn("orchestrator.api", "fork_session_api_error", { session_id: sessionId, code: err.code });
        return c.json({ code: err.code, message: err.message, session_id: sessionId }, err.status as any);
      }
      if (!startupComplete) {
        await rollbackSession(ctx, sessionId);
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = categorizeError(message) as any;
      logger.error("orchestrator.api", "fork_session_error", { session_id: sessionId, code, message });
      return c.json({ code, message, session_id: sessionId }, 500 as any);
    }
  });

  // --- Sessions: Create + Run (blocking) ---

  app.post("/sessions", async (c) => {
    const body = await parseSessionRequest(c, ctx.sessions);
    if ("error" in body) {
      logger.warn("orchestrator.api", "invalid_create_session_request", { error: body.error });
      return c.json(body.error, body.status);
    }

    const sessionId = randomUUID();
    let startupComplete = false;
    logger.info("orchestrator.api", "create_session_request", {
      session_id: sessionId,
      source: body.repo ? "repo" : "workspace",
      pinned: body.pinned,
    });

    try {
      await ensureCapacity(ctx);
      await spawnSession(ctx, sessionId, body);
      await waitForReady(ctx, sessionId);
      startupComplete = true;
      logger.info("orchestrator.api", "session_ready", { session_id: sessionId });

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
      });

      return c.json({
        session_id: sessionId,
        result: result.text,
        usage: result.usage,
      });
    } catch (err) {
      if (isApiError(err)) {
        logger.warn("orchestrator.api", "create_session_api_error", { session_id: sessionId, code: err.code });
        return c.json({ code: err.code, message: err.message, session_id: sessionId }, err.status as any);
      }
      if (!startupComplete) {
        await rollbackSession(ctx, sessionId);
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = categorizeError(message) as any;
      logger.error("orchestrator.api", "create_session_error", { session_id: sessionId, code, message });
      return c.json({ code, message, session_id: sessionId }, 500 as any);
    }
  });

  // --- Sessions: Create + Run (SSE) ---

  app.post("/sessions/stream", async (c) => {
    const body = await parseSessionRequest(c, ctx.sessions);
    if ("error" in body) {
      logger.warn("orchestrator.api", "invalid_stream_request", { error: body.error });
      return c.json(body.error, body.status);
    }

    const sessionId = randomUUID();
    let startupComplete = false;
    logger.info("orchestrator.api", "create_session_stream_request", {
      session_id: sessionId,
      source: body.repo ? "repo" : "workspace",
    });

    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({ event: "session", data: JSON.stringify({ session_id: sessionId, status: "starting" }) });

        await ensureCapacity(ctx);
        await spawnSession(ctx, sessionId, body);

        // Wait for ready, streaming status updates
        await waitForReadyWithStream(ctx, sessionId, async (status) => {
          logger.debug("orchestrator.api", "stream_session_status", { session_id: sessionId, status });
          await stream.writeSSE({ event: "session", data: JSON.stringify({ session_id: sessionId, status }) });
        });
        startupComplete = true;

        // If no message, just signal ready and close
        if (!body.message) return;

        logger.debug("orchestrator.api", "create_session_stream_message_present", {
          session_id: sessionId,
          message_len: body.message.length,
          model: body.model,
        });
        ctx.sessions.incrementMessages(sessionId);

        // Send message and stream events
        await sendAndStream(ctx, sessionId, body.message, { model: body.model, maxTurns: body.maxTurns }, async (event) => {
          const eventType = mapEventType(event.type);
          logger.debug("orchestrator.api", "stream_event", {
            session_id: sessionId,
            event_type: eventType,
            event_subtype: event.subtype,
          });
          await stream.writeSSE({ event: eventType, data: JSON.stringify(event) });
        });
      } catch (err) {
        if (isApiError(err)) {
          logger.warn("orchestrator.api", "stream_api_error", { session_id: sessionId, code: err.code, message: err.message });
          await stream.writeSSE({ event: "error", data: JSON.stringify({ code: err.code, message: err.message, session_id: sessionId }) });
          return;
        }
        if (!startupComplete) {
          await rollbackSession(ctx, sessionId);
        }
        const message = err instanceof Error ? err.message : String(err);
        const code = categorizeError(message);
        logger.error("orchestrator.api", "stream_session_error", { session_id: sessionId, code, message });
        await stream.writeSSE({ event: "error", data: JSON.stringify({ code, message, session_id: sessionId }) });
      }
    });
  });

  // --- Messages: Follow-up (blocking) ---

  app.post("/sessions/:id/messages", async (c) => {
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
      });
      ctx.sessions.incrementMessages(session.id);
      const result = await sendAndCollect(ctx, session.id, body.message, {
        model: body.model,
        maxTurns: body.maxTurns,
      });

      return c.json({ result: result.text, usage: result.usage });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator.api", "send_message_error", { session_id: session.id, message });
      return c.json({ code: "agent_error", message } satisfies ErrorResponse, 500 as any);
    }
  });

  // --- Messages: Follow-up (SSE) ---

  app.post("/sessions/:id/messages/stream", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "messages_stream" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }
    if (session.status === "busy") {
      logger.warn("orchestrator.api", "session_busy", { session_id: session.id, context: "messages_stream" });
      return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    }
    if (session.status === "stopped" || session.status === "error") {
      logger.warn("orchestrator.api", "session_stopped", { session_id: session.id, status: session.status, context: "messages_stream" });
      return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    }

    let body: MessageRequest;
    try {
      body = (await c.req.json()) as MessageRequest;
    } catch {
      logger.warn("orchestrator.api", "invalid_json", { session_id: session.id, endpoint: "/sessions/:id/messages/stream" });
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }

    if (!body.message) {
      logger.warn("orchestrator.api", "message_missing", { session_id: session.id, context: "messages_stream" });
      return c.json({ code: "invalid_request", message: "Missing required field: message" } satisfies ErrorResponse, 400 as any);
    }

    ctx.sessions.incrementMessages(session.id);
    logger.info("orchestrator.api", "send_message_stream", {
      session_id: session.id,
      message_len: body.message.length,
      model: body.model,
    });

    return streamSSE(c, async (stream) => {
      try {
        await sendAndStream(ctx, session.id, body.message, { model: body.model, maxTurns: body.maxTurns }, async (event) => {
          const eventType = mapEventType(event.type);
          logger.debug("orchestrator.api", "stream_event", {
            session_id: session.id,
            event_type: eventType,
            event_subtype: event.subtype,
          });
          await stream.writeSSE({ event: eventType, data: JSON.stringify(event) });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("orchestrator.api", "send_message_stream_error", { session_id: session.id, message });
        await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "agent_error", message }) });
      }
    });
  });

  return app;
}

// --- Helpers ---

async function parseSessionRequest(c: any, sessions?: SessionManager): Promise<SessionRequest | { error: ErrorResponse; status: any }> {
  let body: SessionRequest;
  try {
    body = (await c.req.json()) as SessionRequest;
  } catch {
    logger.warn("orchestrator.api", "invalid_json", { endpoint: "parseSessionRequest" });
    return { error: { code: "invalid_request", message: "Invalid JSON body" }, status: 400 };
  }

  if (!body.repo && !body.workspace) {
    logger.warn("orchestrator.api", "missing_session_source", { has_repo: Boolean(body.repo), has_workspace: Boolean(body.workspace) });
    return { error: { code: "invalid_request", message: "Must provide either repo or workspace" }, status: 400 };
  }

  if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
    logger.warn("orchestrator.api", "invalid_pinned_payload", { pinned: body.pinned });
    return { error: { code: "invalid_request", message: "Field pinned must be a boolean" }, status: 400 };
  }

  if (body.name && sessions?.nameExists(body.name.trim())) {
    logger.warn("orchestrator.api", "duplicate_session_name", { name: body.name.trim() });
    return { error: { code: "invalid_request", message: `Session name "${body.name.trim()}" is already in use` }, status: 409 };
  }

  return body;
}

async function spawnSession(ctx: AppContext, sessionId: string, body: SessionRequest) {
  const model = body.model || "sonnet";
  const maxTurns = body.maxTurns;
  logger.info("orchestrator.session", "spawn_session", {
    session_id: sessionId,
    model,
    repo: body.repo,
    workspace: body.workspace,
    branch: body.branch,
  });

  // Assign an OAuth token from the pool for this session
  const { token, tokenIndex } = ctx.tokenPool.assign(sessionId);
  const sessionEnv = { ...ctx.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  let containerId: string | undefined;

  try {
    containerId = await ctx.docker.spawn({
      sessionId,
      image: ctx.runnerImage,
      orchestratorUrl: ctx.orchestratorWsUrl,
      env: sessionEnv,
      network: ctx.network,
      sessionsVolume: ctx.sessionsVolume,
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
    });

    const session = ctx.sessions.create(sessionId, containerId, tokenIndex, {
      name: body.name?.trim(),
      pinned: body.pinned,
      repo: body.repo,
      branch: body.branch,
      workspace: body.workspace,
      model,
      systemPrompt: body.systemPrompt,
      maxTurns,
    });

    logger.debug("orchestrator.session", "session_db_record_created", { session_id: sessionId });
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

function waitForReady(ctx: AppContext, sessionId: string, timeoutMs = 120_000): Promise<void> {
  // Check if already ready (handles race where status arrived before we listen)
  const session = ctx.sessions.get(sessionId);
  if (session?.status === "ready") return Promise.resolve();
  logger.debug("orchestrator.session", "wait_for_ready", { session_id: sessionId, timeout_ms: timeoutMs });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logger.warn("orchestrator.session", "wait_for_ready_timeout", { session_id: sessionId });
      cleanup();
      reject(new Error("Timed out waiting for runner to be ready"));
    }, timeoutMs);

    const onStatus = (status: string) => {
      logger.debug("orchestrator.session", "wait_for_ready_status", { session_id: sessionId, status });
      if (status === "ready") { cleanup(); resolve(); }
    };
    const onError = (_code: string, message: string) => {
      logger.warn("orchestrator.session", "wait_for_ready_error", { session_id: sessionId, code: _code, message });
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

async function waitForReadyWithStream(
  ctx: AppContext,
  sessionId: string,
  onStatus: (status: string) => Promise<void>,
  timeoutMs = 120_000
): Promise<void> {
  const session = ctx.sessions.get(sessionId);
  if (session?.status === "ready") {
    logger.debug("orchestrator.session", "wait_for_ready_with_stream_already_ready", { session_id: sessionId });
    await onStatus("ready");
    return;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logger.warn("orchestrator.session", "wait_for_ready_with_stream_timeout", { session_id: sessionId });
      cleanup();
      reject(new Error("Timed out waiting for runner to be ready"));
    }, timeoutMs);

    const handleStatus = async (status: string) => {
      logger.debug("orchestrator.session", "wait_for_ready_status_stream", { session_id: sessionId, status });
      await onStatus(status);
      if (status === "ready") { cleanup(); resolve(); }
    };
    const handleError = (_code: string, message: string) => {
      logger.warn("orchestrator.session", "wait_for_ready_with_stream_error", { session_id: sessionId, code: _code, message });
      cleanup();
      reject(new Error(message));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ctx.bridge.removeListener(`status:${sessionId}`, handleStatus);
      ctx.bridge.removeListener(`error:${sessionId}`, handleError);
    };

    ctx.bridge.on(`status:${sessionId}`, handleStatus);
    ctx.bridge.on(`error:${sessionId}`, handleError);
  });
}

function sendAndCollect(
  ctx: AppContext,
  sessionId: string,
  message: string,
  overrides?: { model?: string; maxTurns?: number }
): Promise<{ text: string; usage: Usage }> {
  logger.debug("orchestrator.session", "send_and_collect", {
    session_id: sessionId,
    model: overrides?.model,
    max_turns: overrides?.maxTurns,
    message_len: message.length,
  });
  return new Promise((resolve, reject) => {
    let text = "";
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 };
    const timeout = setTimeout(() => {
      logger.warn("orchestrator.session", "send_and_collect_timeout", { session_id: sessionId, timeout_ms: ctx.messageTimeoutMs });
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
          });
          resolve({ text: event.result || text, usage });
        } else {
          logger.warn("orchestrator.session", "send_and_collect_result_error", {
            session_id: sessionId,
            subtype: event.subtype,
            errors: event.errors,
          });
          reject(new Error(event.errors?.join(", ") || "Agent execution failed"));
        }
      }
    };
    const onError = (_code: string, message: string) => {
      logger.warn("orchestrator.session", "send_and_collect_error", { session_id: sessionId, code: _code, message });
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

    const sent = ctx.bridge.sendMessage(sessionId, message, overrides);
    if (!sent) {
      cleanup();
      reject(new Error("Runner not connected"));
    }
  });
}

async function sendAndStream(
  ctx: AppContext,
  sessionId: string,
  message: string,
  overrides: { model?: string; maxTurns?: number } | undefined,
  onStreamEvent: (event: RunnerEvent) => Promise<void>
): Promise<void> {
  logger.debug("orchestrator.session", "send_and_stream", {
    session_id: sessionId,
    model: overrides?.model,
    max_turns: overrides?.maxTurns,
    message_len: message.length,
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logger.warn("orchestrator.session", "send_and_stream_timeout", { session_id: sessionId, timeout_ms: ctx.messageTimeoutMs });
      cleanup();
      reject(new Error(`Timed out waiting for runner result after ${ctx.messageTimeoutMs}ms`));
    }, ctx.messageTimeoutMs);

    const onEvent = async (event: RunnerEvent) => {
      logger.debug("orchestrator.session", "send_and_stream_event", {
        session_id: sessionId,
        event_type: event.type,
        event_subtype: event.subtype,
      });
      await onStreamEvent(event);
      if (event.type === "result") {
        cleanup();
        const usage: Usage = {
          input_tokens: event.usage?.input_tokens || 0,
          output_tokens: event.usage?.output_tokens || 0,
          cost_usd: event.usage?.cost_usd || 0,
          duration_ms: event.usage?.duration_ms || 0,
        };
        ctx.sessions.addUsage(sessionId, usage);
        logger.info("orchestrator.session", "send_and_stream_complete", { session_id: sessionId, usage });
        resolve();
      }
    };
    const onError = (_code: string, message: string) => {
      logger.warn("orchestrator.session", "send_and_stream_error", { session_id: sessionId, code: _code, message });
      cleanup(); reject(new Error(message));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ctx.bridge.removeListener(`event:${sessionId}`, onEvent);
      ctx.bridge.removeListener(`error:${sessionId}`, onError);
    };

    ctx.bridge.on(`event:${sessionId}`, onEvent);
    ctx.bridge.on(`error:${sessionId}`, onError);

    const sent = ctx.bridge.sendMessage(sessionId, message, overrides);
    if (!sent) {
      cleanup();
      reject(new Error("Runner not connected"));
    }
  });
}

function mapEventType(type: string): string {
  return type;
}

function categorizeError(message: string): string {
  if (message.includes("clone") || message.includes("git") || message.includes("Authentication")) return "clone_failed";
  if (message.includes("container") || message.includes("Container")) return "container_failed";
  if (message.includes("timeout") || message.includes("Timed out")) return "timeout";
  return "internal";
}

async function rollbackSession(ctx: AppContext, sessionId: string): Promise<void> {
  logger.warn("orchestrator.session", "rollback_session", { session_id: sessionId });
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

import { randomUUID } from "crypto";
import type { Hono } from "hono";
import { logger } from "../../logger.js";
import * as metrics from "../../metrics.js";
import type { ErrorResponse, ForkRequest, MessageRequest } from "../../types.js";
import { getTenant } from "../app-context.js";
import type { AppContext } from "../app-context.js";
import { ensureCapacity, isApiError } from "../services/capacity.js";
import {
  categorizeError,
  getSessionSource,
  getTranscriptResponse,
  parseSessionRequest,
  resolveCredentials,
  rollbackSession,
  sendAndCollect,
  spawnSession,
  stopSessionRuntime,
  waitForReady,
} from "../services/session-runtime.js";

export function registerSessionRoutes(app: Hono, ctx: AppContext): void {
  app.get("/sessions", async (c) => {
    const tenant = getTenant(ctx, c);
    const sessions = ctx.sessions.list(tenant?.id);
    const results = await Promise.all(sessions.map(async (session) => ({
      session_id: session.id,
      name: session.name,
      pinned: session.pinned,
      agent_id: session.agentId,
      status: session.status,
      source: getSessionSource(session),
      model: session.model,
      pod_ip: await ctx.docker.getPodIp(session.id),
      created_at: session.createdAt.toISOString(),
      last_activity: session.lastActivity.toISOString(),
      message_count: session.messageCount,
    })));
    logger.debug("orchestrator.api", "list_sessions", { count: results.length });
    return c.json({ sessions: results });
  });

  app.get("/sessions/:id", async (c) => {
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
      agent_id: session.agentId,
      status: session.status,
      source: getSessionSource(session),
      model: session.model,
      pod_ip: await ctx.docker.getPodIp(session.id),
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

  app.get("/sessions/:id/transcript", async (c) => {
    const result = await getTranscriptResponse(ctx, c.req.param("id"), c.req.query("format"));
    if (result.kind === "raw") return result.response;
    if (result.kind === "error") return c.json(result.body, result.status as any);
    return c.json(result.body);
  });

  app.patch("/sessions/:id", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "rename" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    let body: { name?: string; pinned?: boolean };
    try {
      body = await c.req.json();
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

  app.delete("/sessions/:id", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "delete" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }
    logger.info("orchestrator.api", "delete_session_request", { session_id: session.id });

    await stopSessionRuntime(ctx, session.id);
    const result = {
      session_id: session.id,
      status: "stopped" as const,
      total_usage: session.totalUsage,
    };

    ctx.sessions.remove(session.id);
    return c.json(result);
  });

  app.post("/sessions/:id/stop", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "stop" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }
    logger.info("orchestrator.api", "stop_session_request", { session_id: session.id, status: session.status });

    if (session.status !== "stopped" && session.status !== "error") {
      await stopSessionRuntime(ctx, session.id);
      ctx.sessions.updateStatus(session.id, "stopped");
    } else {
      ctx.sessions.clearRuntime(session.id);
      ctx.tokenPool?.release(session.id);
    }

    const refreshed = ctx.sessions.get(session.id) ?? session;
    return c.json({
      session_id: refreshed.id,
      status: refreshed.status,
      total_usage: refreshed.totalUsage,
    });
  });

  app.post("/sessions/:id/resume", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      logger.warn("orchestrator.api", "session_not_found", { session_id: c.req.param("id"), context: "resume" });
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    if (session.status !== "stopped" && session.status !== "error") {
      return c.json({ session_id: session.id, status: session.status });
    }

    if (!session.sdkSessionId) {
      return c.json(
        { code: "invalid_request", message: "Cannot resume session without an SDK session ID", session_id: session.id } satisfies ErrorResponse,
        400 as any,
      );
    }

    logger.info("orchestrator.api", "resume_session_request", {
      session_id: session.id,
      status: session.status,
      request_id: requestId,
    });

    ctx.sessions.clearRuntime(session.id);
    ctx.tokenPool?.release(session.id);
    await ctx.docker.kill(session.id).catch(() => undefined);

    if (!ctx.tokenPool) throw new Error("Token pool required for session restart");
    const { token, tokenIndex } = ctx.tokenPool.assign(session.id);
    const credentialsEnv = await resolveCredentials(ctx, session.tenantId, session.vaultName);
    const sessionEnv = { ...ctx.env, CLAUDE_CODE_OAUTH_TOKEN: token };

    try {
      const containerId = await ctx.docker.spawn({
        sessionId: session.id,
        image: ctx.runnerImage,
        orchestratorUrl: ctx.orchestratorWsUrl,
        env: sessionEnv,
        credentialsEnv,
        network: ctx.network,
        sessionsVolume: ctx.sessionsVolume,
        repo: session.repo,
        branch: session.branch,
        workspace: session.workspace,
        vault: session.vaultName,
        model: session.model,
        systemPrompt: session.systemPrompt,
        maxTurns: session.maxTurns,
        thinking: session.thinking,
        additionalDirectories: session.additionalDirectories,
        compactInstructions: session.compactInstructions,
        permissionMode: session.permissionMode,
        mcpServers: session.mcpServers,
        allowedPaths: session.allowedPaths,
        sdkSessionId: session.sdkSessionId,
      });

      ctx.sessions.reactivate(session.id, containerId, tokenIndex);
      await waitForReady(ctx, session.id, undefined, requestId);
      return c.json({ session_id: session.id, status: "ready" as const });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator.api", "resume_session_error", {
        session_id: session.id,
        message,
        request_id: requestId,
      });
      ctx.bridge.sendShutdown(session.id);
      await ctx.docker.kill(session.id).catch(() => undefined);
      ctx.sessions.clearRuntime(session.id);
      ctx.tokenPool?.release(session.id);
      ctx.sessions.setError(session.id, message);
      return c.json({ code: categorizeError(message) as any, message, session_id: session.id }, 500 as any);
    }
  });

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
      body = await c.req.json();
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

      if (!ctx.tokenPool) throw new Error("Token pool required for fork");
      const { token, tokenIndex } = ctx.tokenPool.assign(sessionId);
      const credentialsEnv = await resolveCredentials(ctx, parent.tenantId, parent.vaultName);
      const sessionEnv = { ...ctx.env, CLAUDE_CODE_OAUTH_TOKEN: token };

      const containerId = await ctx.docker.spawn({
        sessionId,
        image: ctx.runnerImage,
        orchestratorUrl: ctx.orchestratorWsUrl,
        env: sessionEnv,
        credentialsEnv,
        network: ctx.network,
        sessionsVolume: ctx.sessionsVolume,
        vault: parent.vaultName,
        repo: parent.repo,
        branch: parent.branch,
        workspace: parent.workspace,
        model,
        systemPrompt: body.systemPrompt || parent.systemPrompt,
        appendSystemPrompt: body.appendSystemPrompt,
        maxTurns: body.maxTurns ?? parent.maxTurns,
        thinking: parent.thinking,
        additionalDirectories: parent.additionalDirectories,
        compactInstructions: parent.compactInstructions,
        permissionMode: parent.permissionMode,
        mcpServers: parent.mcpServers,
        allowedPaths: parent.allowedPaths,
        forkFrom: parent.sdkSessionId,
        forkAt: body.resumeAt,
        forkSession: true,
      });

      ctx.sessions.create(sessionId, containerId, tokenIndex, {
        repo: parent.repo,
        branch: parent.branch,
        workspace: parent.workspace,
        vaultName: parent.vaultName,
        agentId: parent.agentId,
        model,
        pinned: body.pinned ?? parent.pinned,
        systemPrompt: body.systemPrompt || parent.systemPrompt,
        maxTurns: body.maxTurns ?? parent.maxTurns,
        thinking: parent.thinking,
        additionalDirectories: parent.additionalDirectories,
        compactInstructions: parent.compactInstructions,
        permissionMode: parent.permissionMode,
        mcpServers: parent.mcpServers,
        allowedPaths: parent.allowedPaths,
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

  app.post("/sessions", async (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const tenant = getTenant(ctx, c);
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
      const spawnStart = performance.now();
      await spawnSession(ctx, sessionId, body, requestId, tenant?.id);
      await waitForReady(ctx, sessionId, undefined, requestId);
      startupComplete = true;
      const sourceType = body.repo ? "repo" : body.vault ? "vault" : body.workspace ? "workspace" : "ephemeral";
      metrics.spawnDurationSeconds.observe(
        { backend: ctx.docker.constructor.name === "K8sManager" ? "k8s" : "docker", source_type: sourceType },
        (performance.now() - spawnStart) / 1000,
      );
      logger.info("orchestrator.api", "session_ready", { session_id: sessionId, request_id: requestId });

      if (!body.message) {
        return c.json({ session_id: sessionId, status: "ready", pod_ip: await ctx.docker.getPodIp(sessionId) });
      }

      logger.debug("orchestrator.api", "create_session_message_present", {
        session_id: sessionId,
        message_len: body.message.length,
        model: body.model,
      });
      ctx.sessions.incrementMessages(sessionId);

      const result = await sendAndCollect(ctx, sessionId, body.message, {
        model: body.model,
        maxTurns: body.maxTurns,
        requestId,
      });

      return c.json({
        session_id: sessionId,
        pod_ip: await ctx.docker.getPodIp(sessionId),
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
      body = await c.req.json();
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
}

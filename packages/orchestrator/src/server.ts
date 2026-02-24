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
  ErrorResponse,
  RunnerEvent,
  Usage,
} from "./types.js";
import type { TokenPool } from "./token-pool.js";

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
  startedAt: Date;
}

export function createServer(ctx: AppContext): Hono {
  const app = new Hono();

  // --- Health ---

  app.get("/health", async (c) => {
    const dockerConnected = await ctx.docker.checkConnection();
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
    });
  });

  // --- Sessions: List ---

  app.get("/sessions", (c) => {
    const sessions = ctx.sessions.list().map((s) => ({
      session_id: s.id,
      name: s.name,
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
    return c.json({ sessions });
  });

  // --- Sessions: Get detail ---

  app.get("/sessions/:id", (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    return c.json({
      session_id: session.id,
      name: session.name,
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
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    // Claude SDK stores transcripts at: <claude-dir>/projects/-workspace/<session-id>.jsonl
    const transcriptPath = join(ctx.sessionsPath, "projects", "-workspace", `${session.id}.jsonl`);

    if (!existsSync(transcriptPath)) {
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
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    let body: { name?: string };
    try {
      body = (await c.req.json()) as { name?: string };
    } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }

    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ code: "invalid_request", message: "Missing or empty required field: name" } satisfies ErrorResponse, 400 as any);
    }

    const name = body.name.trim();
    const ok = ctx.sessions.rename(session.id, name);
    if (!ok) {
      return c.json({ code: "invalid_request", message: `Session name "${name}" is already in use` } satisfies ErrorResponse, 409 as any);
    }

    return c.json({ session_id: session.id, name });
  });

  // --- Sessions: Delete ---

  app.delete("/sessions/:id", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

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
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    if (!parent.sdkSessionId) {
      return c.json({ code: "invalid_request", message: "Cannot fork: parent session has no SDK session ID (has it processed a message yet?)" } satisfies ErrorResponse, 400 as any);
    }

    let body: ForkRequest;
    try {
      body = (await c.req.json()) as ForkRequest;
    } catch {
      body = {};
    }

    const sessionId = randomUUID();
    const model = body.model || parent.model;

    try {
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
        systemPrompt: body.systemPrompt || parent.systemPrompt,
        maxTurns: body.maxTurns ?? parent.maxTurns,
        forkedFrom: parent.id,
      });

      await waitForReady(ctx, sessionId);

      // If a message was provided, send it immediately
      if (body.message) {
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
      const message = err instanceof Error ? err.message : String(err);
      const code = categorizeError(message) as any;
      return c.json({ code, message, session_id: sessionId }, 500 as any);
    }
  });

  // --- Sessions: Create + Run (blocking) ---

  app.post("/sessions", async (c) => {
    const body = await parseSessionRequest(c, ctx.sessions);
    if ("error" in body) return c.json(body.error, body.status);

    const sessionId = randomUUID();

    try {
      await spawnSession(ctx, sessionId, body);
      await waitForReady(ctx, sessionId);

      // If no message, just return the ready session
      if (!body.message) {
        return c.json({ session_id: sessionId, status: "ready" });
      }

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
      const message = err instanceof Error ? err.message : String(err);
      const code = categorizeError(message) as any;
      return c.json({ code, message, session_id: sessionId }, 500 as any);
    }
  });

  // --- Sessions: Create + Run (SSE) ---

  app.post("/sessions/stream", async (c) => {
    const body = await parseSessionRequest(c, ctx.sessions);
    if ("error" in body) return c.json(body.error, body.status);

    const sessionId = randomUUID();

    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({ event: "session", data: JSON.stringify({ session_id: sessionId, status: "starting" }) });

        await spawnSession(ctx, sessionId, body);

        // Wait for ready, streaming status updates
        await waitForReadyWithStream(ctx, sessionId, async (status) => {
          await stream.writeSSE({ event: "session", data: JSON.stringify({ session_id: sessionId, status }) });
        });

        // If no message, just signal ready and close
        if (!body.message) return;

        ctx.sessions.incrementMessages(sessionId);

        // Send message and stream events
        await sendAndStream(ctx, sessionId, body.message!, { model: body.model, maxTurns: body.maxTurns }, async (event) => {
          const eventType = mapEventType(event.type);
          await stream.writeSSE({ event: eventType, data: JSON.stringify(event) });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = categorizeError(message);
        await stream.writeSSE({ event: "error", data: JSON.stringify({ code, message, session_id: sessionId }) });
      }
    });
  });

  // --- Messages: Follow-up (blocking) ---

  app.post("/sessions/:id/messages", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "busy") return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    if (session.status === "stopped" || session.status === "error") {
      return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    }

    let body: MessageRequest;
    try {
      body = (await c.req.json()) as MessageRequest;
    } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }

    if (!body.message) {
      return c.json({ code: "invalid_request", message: "Missing required field: message" } satisfies ErrorResponse, 400 as any);
    }

    try {
      ctx.sessions.incrementMessages(session.id);
      const result = await sendAndCollect(ctx, session.id, body.message, {
        model: body.model,
        maxTurns: body.maxTurns,
      });

      return c.json({ result: result.text, usage: result.usage });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ code: "agent_error", message } satisfies ErrorResponse, 500 as any);
    }
  });

  // --- Messages: Follow-up (SSE) ---

  app.post("/sessions/:id/messages/stream", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    if (session.status === "busy") return c.json({ code: "session_busy", message: "Session is currently processing" } satisfies ErrorResponse, 409 as any);
    if (session.status === "stopped" || session.status === "error") {
      return c.json({ code: "session_stopped", message: "Session has stopped" } satisfies ErrorResponse, 410 as any);
    }

    let body: MessageRequest;
    try {
      body = (await c.req.json()) as MessageRequest;
    } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }

    if (!body.message) {
      return c.json({ code: "invalid_request", message: "Missing required field: message" } satisfies ErrorResponse, 400 as any);
    }

    ctx.sessions.incrementMessages(session.id);

    return streamSSE(c, async (stream) => {
      try {
        await sendAndStream(ctx, session.id, body.message, { model: body.model, maxTurns: body.maxTurns }, async (event) => {
          const eventType = mapEventType(event.type);
          await stream.writeSSE({ event: eventType, data: JSON.stringify(event) });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
    return { error: { code: "invalid_request", message: "Invalid JSON body" }, status: 400 };
  }

  if (!body.repo && !body.workspace) {
    return { error: { code: "invalid_request", message: "Must provide either repo or workspace" }, status: 400 };
  }

  if (body.name && sessions?.nameExists(body.name.trim())) {
    return { error: { code: "invalid_request", message: `Session name "${body.name.trim()}" is already in use` }, status: 409 };
  }

  return body;
}

async function spawnSession(ctx: AppContext, sessionId: string, body: SessionRequest) {
  const model = body.model || "sonnet";
  const maxTurns = body.maxTurns;

  // Assign an OAuth token from the pool for this session
  const { token, tokenIndex } = ctx.tokenPool.assign(sessionId);
  const sessionEnv = { ...ctx.env, CLAUDE_CODE_OAUTH_TOKEN: token };

  const containerId = await ctx.docker.spawn({
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
    repo: body.repo,
    branch: body.branch,
    workspace: body.workspace,
    model,
    systemPrompt: body.systemPrompt,
    maxTurns,
  });

  return { session, containerId };
}

function waitForReady(ctx: AppContext, sessionId: string, timeoutMs = 120_000): Promise<void> {
  // Check if already ready (handles race where status arrived before we listen)
  const session = ctx.sessions.get(sessionId);
  if (session?.status === "ready") return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for runner to be ready"));
    }, timeoutMs);

    const onStatus = (status: string) => {
      if (status === "ready") { cleanup(); resolve(); }
    };
    const onError = (_code: string, message: string) => {
      cleanup(); reject(new Error(message));
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
    await onStatus("ready");
    return;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup(); reject(new Error("Timed out waiting for runner to be ready"));
    }, timeoutMs);

    const handleStatus = async (status: string) => {
      await onStatus(status);
      if (status === "ready") { cleanup(); resolve(); }
    };
    const handleError = (_code: string, message: string) => {
      cleanup(); reject(new Error(message));
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
  return new Promise((resolve, reject) => {
    let text = "";
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 };

    const onEvent = (event: RunnerEvent) => {
      if (event.type === "assistant") {
        text += event.content || "";
      } else if (event.type === "result") {
        cleanup();
        usage.input_tokens = event.usage?.input_tokens || 0;
        usage.output_tokens = event.usage?.output_tokens || 0;
        usage.cost_usd = event.usage?.cost_usd || 0;
        usage.duration_ms = event.usage?.duration_ms || 0;
        ctx.sessions.addUsage(sessionId, usage);

        if (event.subtype === "success") {
          resolve({ text: event.result || text, usage });
        } else {
          reject(new Error(event.errors?.join(", ") || "Agent execution failed"));
        }
      }
    };
    const onError = (_code: string, message: string) => {
      cleanup(); reject(new Error(message));
    };
    const cleanup = () => {
      ctx.bridge.removeListener(`event:${sessionId}`, onEvent);
      ctx.bridge.removeListener(`error:${sessionId}`, onError);
    };

    ctx.bridge.on(`event:${sessionId}`, onEvent);
    ctx.bridge.on(`error:${sessionId}`, onError);

    const sent = ctx.bridge.sendMessage(sessionId, message, overrides);
    if (!sent) { cleanup(); reject(new Error("Runner not connected")); }
  });
}

async function sendAndStream(
  ctx: AppContext,
  sessionId: string,
  message: string,
  overrides: { model?: string; maxTurns?: number } | undefined,
  onStreamEvent: (event: RunnerEvent) => Promise<void>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = async (event: RunnerEvent) => {
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
        resolve();
      }
    };
    const onError = (_code: string, message: string) => {
      cleanup(); reject(new Error(message));
    };
    const cleanup = () => {
      ctx.bridge.removeListener(`event:${sessionId}`, onEvent);
      ctx.bridge.removeListener(`error:${sessionId}`, onError);
    };

    ctx.bridge.on(`event:${sessionId}`, onEvent);
    ctx.bridge.on(`error:${sessionId}`, onError);

    const sent = ctx.bridge.sendMessage(sessionId, message, overrides);
    if (!sent) { cleanup(); reject(new Error("Runner not connected")); }
  });
}

function mapEventType(type: string): string {
  switch (type) {
    case "assistant": return "assistant";
    case "assistant_delta": return "assistant";
    case "tool_use": return "tool";
    case "tool_result": return "tool_result";
    case "tool_progress": return "tool_progress";
    case "thinking": return "thinking";
    case "result": return "result";
    default: return type;
  }
}

function categorizeError(message: string): string {
  if (message.includes("clone") || message.includes("git") || message.includes("Authentication")) return "clone_failed";
  if (message.includes("container") || message.includes("Container")) return "container_failed";
  if (message.includes("timeout") || message.includes("Timed out")) return "timeout";
  return "internal";
}

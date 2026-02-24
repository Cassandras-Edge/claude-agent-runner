import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "crypto";
import type { SessionManager } from "./sessions.js";
import type { DockerManager } from "./docker.js";
import type { WsBridge } from "./ws-bridge.js";
import type {
  SessionRequest,
  MessageRequest,
  ErrorResponse,
  RunnerEvent,
  Usage,
} from "./types.js";

interface AppContext {
  sessions: SessionManager;
  docker: DockerManager;
  bridge: WsBridge;
  env: Record<string, string>;
  runnerImage: string;
  network: string;
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
      uptime_ms: Date.now() - ctx.startedAt.getTime(),
      runner_image: ctx.runnerImage,
      docker_connected: dockerConnected,
    });
  });

  // --- Sessions: List ---

  app.get("/sessions", (c) => {
    const sessions = ctx.sessions.list().map((s) => ({
      session_id: s.id,
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
    });
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
    return c.json(result);
  });

  // --- Sessions: Create + Run (blocking) ---

  app.post("/sessions", async (c) => {
    const body = await parseSessionRequest(c);
    if ("error" in body) return c.json(body.error, body.status);

    const sessionId = randomUUID();

    try {
      await spawnSession(ctx, sessionId, body);
      await waitForReady(ctx, sessionId);
      ctx.sessions.incrementMessages(sessionId);

      const result = await sendAndCollect(ctx, sessionId, body.message, {
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
    const body = await parseSessionRequest(c);
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

        ctx.sessions.incrementMessages(sessionId);

        // Send message and stream events
        await sendAndStream(ctx, sessionId, body.message, { model: body.model, maxTurns: body.maxTurns }, async (event) => {
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

async function parseSessionRequest(c: any): Promise<SessionRequest | { error: ErrorResponse; status: any }> {
  let body: SessionRequest;
  try {
    body = (await c.req.json()) as SessionRequest;
  } catch {
    return { error: { code: "invalid_request", message: "Invalid JSON body" }, status: 400 };
  }

  if (!body.message) {
    return { error: { code: "invalid_request", message: "Missing required field: message" }, status: 400 };
  }

  if (!body.repo && !body.workspace) {
    return { error: { code: "invalid_request", message: "Must provide either repo or workspace" }, status: 400 };
  }

  return body;
}

async function spawnSession(ctx: AppContext, sessionId: string, body: SessionRequest) {
  const model = body.model || "sonnet";
  const maxTurns = body.maxTurns || 25;

  const containerId = await ctx.docker.spawn({
    sessionId,
    image: ctx.runnerImage,
    orchestratorUrl: ctx.orchestratorWsUrl,
    env: ctx.env,
    network: ctx.network,
    repo: body.repo,
    branch: body.branch,
    workspace: body.workspace,
    model,
    systemPrompt: body.systemPrompt,
    maxTurns,
  });

  const session = ctx.sessions.create(sessionId, containerId, {
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

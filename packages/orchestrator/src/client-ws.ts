import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { randomUUID } from "crypto";
import type { SessionManager } from "./sessions.js";
import type { WsBridge } from "./ws-bridge.js";
import type { RunnerEvent } from "./types.js";
import { logger, runWithLogContext } from "./logger.js";

// --- Client → Server frame types ---

interface SubscribeFrame {
  type: "subscribe";
  session_id: string;
  request_id?: string;
}

interface UnsubscribeFrame {
  type: "unsubscribe";
  session_id: string;
}

interface SendFrame {
  type: "send";
  session_id: string;
  message: string;
  model?: string;
  max_turns?: number;
  max_thinking_tokens?: number;
  request_id?: string;
}

interface SteerFrame {
  type: "steer";
  session_id: string;
  message: string;
  mode?: "steer" | "fork_and_steer";
  model?: string;
  max_turns?: number;
  max_thinking_tokens?: number;
  compact?: boolean;
  compact_instructions?: string;
  operations?: any[];
  request_id?: string;
}

interface CompactFrame {
  type: "compact";
  session_id: string;
  custom_instructions?: string;
  request_id?: string;
}

interface PingFrame {
  type: "ping";
}

type ClientFrame = SubscribeFrame | UnsubscribeFrame | SendFrame | SteerFrame | CompactFrame | PingFrame;

// --- Server → Client frame types ---

interface ServerFrame {
  type: string;
  [key: string]: any;
}

interface AttachOptions {
  bridge: WsBridge;
  sessions: SessionManager;
}

export function attachClientWs(
  httpServer: { on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): any },
  { bridge, sessions }: AttachOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request) => {
    const connectionId = randomUUID();
    const connectedAt = Date.now();
    const subscriptions = new Map<string, () => void>();
    const remoteAddr = request.headers["x-forwarded-for"] as string || request.socket.remoteAddress || "unknown";

    runWithLogContext({ traceId: connectionId, connectionId }, () => {
      logger.event("client-ws", "client_connected", {
        connection_id: connectionId,
        remote_addr: remoteAddr,
      });

      ws.on("message", (data: Buffer) => {
        let frame: ClientFrame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          sendFrame(ws, { type: "error", error_code: "invalid_request", message: "Invalid JSON" });
          return;
        }

        const requestId = (frame as any).request_id || randomUUID();
        const sessionId = (frame as any).session_id;

        runWithLogContext({ traceId: connectionId, connectionId, requestId, sessionId }, () => {
          handleFrame(ws, frame, {
            connectionId,
            requestId,
            subscriptions,
            bridge,
            sessions,
          });
        });
      });

      ws.on("close", () => {
        const subCount = subscriptions.size;
        // Tear down all subscriptions
        for (const cleanup of subscriptions.values()) {
          cleanup();
        }
        subscriptions.clear();

        logger.event("client-ws", "client_disconnected", {
          connection_id: connectionId,
          subscriptions: subCount,
          duration_ms: Date.now() - connectedAt,
        });
      });

      ws.on("error", (err) => {
        logger.error("client-ws", "ws_error", {
          connection_id: connectionId,
          error: err.message,
        });
      });
    });
  });

  return wss;
}

// --- Frame handler ---

interface HandleContext {
  connectionId: string;
  requestId: string;
  subscriptions: Map<string, () => void>;
  bridge: WsBridge;
  sessions: SessionManager;
}

function handleFrame(ws: WebSocket, frame: ClientFrame, ctx: HandleContext): void {
  logger.debug("client-ws", "frame_in", {
    direction: "in",
    frame_type: frame.type,
    session_id: (frame as any).session_id,
    request_id: ctx.requestId,
    message_len: (frame as any).message?.length,
  });

  switch (frame.type) {
    case "ping":
      sendFrame(ws, { type: "pong" });
      return;

    case "subscribe":
      handleSubscribe(ws, frame, ctx);
      return;

    case "unsubscribe":
      handleUnsubscribe(ws, frame, ctx);
      return;

    case "send":
      handleSend(ws, frame, ctx);
      return;

    case "steer":
      handleSteer(ws, frame, ctx);
      return;

    case "compact":
      handleCompact(ws, frame, ctx);
      return;

    default:
      sendFrame(ws, {
        type: "error",
        error_code: "invalid_request",
        message: `Unknown frame type: ${(frame as any).type}`,
        request_id: ctx.requestId,
      });
  }
}

// --- Subscribe ---

function handleSubscribe(ws: WebSocket, frame: SubscribeFrame, ctx: HandleContext): void {
  const { session_id } = frame;

  // Already subscribed?
  if (ctx.subscriptions.has(session_id)) {
    sendFrame(ws, {
      type: "error",
      error_code: "invalid_request",
      message: "Already subscribed to this session",
      session_id,
      request_id: ctx.requestId,
    });
    return;
  }

  const session = ctx.sessions.get(session_id);
  if (!session) {
    sendFrame(ws, {
      type: "error",
      error_code: "session_not_found",
      message: "Session not found",
      session_id,
      request_id: ctx.requestId,
    });
    return;
  }

  // Attach bridge EventEmitter listeners
  const onStatus = (status: string) => {
    sendFrame(ws, {
      type: "status",
      session_id,
      status,
    });
    logger.debug("client-ws", "frame_out", {
      direction: "out",
      frame_type: "status",
      session_id,
      status,
    });
  };

  const onEvent = (event: RunnerEvent) => {
    sendFrame(ws, {
      type: "event",
      session_id,
      event,
    });
    logger.debug("client-ws", "frame_out", {
      direction: "out",
      frame_type: "event",
      session_id,
      event_type: event.type,
      event_subtype: event.subtype,
    });
  };

  const onError = (code: string, message: string) => {
    sendFrame(ws, {
      type: "error",
      session_id,
      error_code: code,
      message,
    });
    logger.debug("client-ws", "frame_out", {
      direction: "out",
      frame_type: "error",
      session_id,
      error_code: code,
    });
  };

  const onContextState = (contextTokens: number, compacted?: boolean) => {
    sendFrame(ws, {
      type: "context_state",
      session_id,
      context_tokens: contextTokens,
      compacted,
    });
    logger.debug("client-ws", "frame_out", {
      direction: "out",
      frame_type: "context_state",
      session_id,
      context_tokens: contextTokens,
    });
  };

  ctx.bridge.on(`status:${session_id}`, onStatus);
  ctx.bridge.on(`event:${session_id}`, onEvent);
  ctx.bridge.on(`error:${session_id}`, onError);
  ctx.bridge.on(`context_state:${session_id}`, onContextState);

  // Store cleanup function
  const cleanup = () => {
    ctx.bridge.removeListener(`status:${session_id}`, onStatus);
    ctx.bridge.removeListener(`event:${session_id}`, onEvent);
    ctx.bridge.removeListener(`error:${session_id}`, onError);
    ctx.bridge.removeListener(`context_state:${session_id}`, onContextState);
  };
  ctx.subscriptions.set(session_id, cleanup);

  // Send subscribed ack with current status
  sendFrame(ws, {
    type: "subscribed",
    session_id,
    status: session.status,
    request_id: ctx.requestId,
  });

  logger.event("client-ws", "subscribed", {
    session_id,
    status: session.status,
    subscriptions: ctx.subscriptions.size,
    request_id: ctx.requestId,
  });
}

// --- Unsubscribe ---

function handleUnsubscribe(ws: WebSocket, frame: UnsubscribeFrame, ctx: HandleContext): void {
  const { session_id } = frame;
  const cleanup = ctx.subscriptions.get(session_id);

  if (!cleanup) {
    sendFrame(ws, {
      type: "error",
      error_code: "invalid_request",
      message: "Not subscribed to this session",
      session_id,
    });
    return;
  }

  cleanup();
  ctx.subscriptions.delete(session_id);

  logger.event("client-ws", "unsubscribed", {
    session_id,
    subscriptions: ctx.subscriptions.size,
  });
}

// --- Send ---

function handleSend(ws: WebSocket, frame: SendFrame, ctx: HandleContext): void {
  const { session_id, message, model, max_turns, max_thinking_tokens } = frame;

  const session = ctx.sessions.get(session_id);
  if (!session) {
    sendFrame(ws, { type: "ack", session_id, ok: false, error: "Session not found", request_id: ctx.requestId });
    return;
  }
  if (session.status === "busy") {
    sendFrame(ws, { type: "ack", session_id, ok: false, error: "Session is busy", request_id: ctx.requestId });
    return;
  }
  if (session.status === "stopped" || session.status === "error") {
    sendFrame(ws, { type: "ack", session_id, ok: false, error: "Session has stopped", request_id: ctx.requestId });
    return;
  }

  ctx.sessions.incrementMessages(session_id);
  const sent = ctx.bridge.sendMessage(session_id, message, {
    model,
    maxTurns: max_turns,
    maxThinkingTokens: max_thinking_tokens,
    requestId: ctx.requestId,
    traceId: ctx.connectionId,
  });

  sendFrame(ws, { type: "ack", session_id, ok: sent, request_id: ctx.requestId, ...(!sent ? { error: "Runner not connected" } : {}) });

  logger.event("client-ws", "send_dispatched", {
    session_id,
    message_len: message.length,
    model,
    ok: sent,
    request_id: ctx.requestId,
  });
}

// --- Steer ---

function handleSteer(ws: WebSocket, frame: SteerFrame, ctx: HandleContext): void {
  const { session_id, message, mode = "steer", model, max_turns, max_thinking_tokens, compact, compact_instructions, operations } = frame;

  const session = ctx.sessions.get(session_id);
  if (!session) {
    sendFrame(ws, { type: "ack", session_id, ok: false, error: "Session not found", request_id: ctx.requestId });
    return;
  }
  if (session.status === "stopped" || session.status === "error") {
    sendFrame(ws, { type: "ack", session_id, ok: false, error: "Session has stopped", request_id: ctx.requestId });
    return;
  }

  let sent: boolean;
  if (mode === "fork_and_steer") {
    sent = ctx.bridge.sendForkAndSteer(session_id, message, {
      model,
      maxTurns: max_turns,
      maxThinkingTokens: max_thinking_tokens,
      requestId: ctx.requestId,
      traceId: ctx.connectionId,
    });
  } else {
    sent = ctx.bridge.sendSteer(session_id, message, {
      model,
      maxTurns: max_turns,
      maxThinkingTokens: max_thinking_tokens,
      compact,
      compactInstructions: compact_instructions,
      operations,
      requestId: ctx.requestId,
      traceId: ctx.connectionId,
    });
  }

  sendFrame(ws, { type: "ack", session_id, ok: sent, request_id: ctx.requestId, ...(!sent ? { error: "Runner not connected" } : {}) });

  logger.event("client-ws", "steer_dispatched", {
    session_id,
    mode,
    model,
    ok: sent,
    request_id: ctx.requestId,
  });
}

// --- Compact ---

function handleCompact(ws: WebSocket, frame: CompactFrame, ctx: HandleContext): void {
  const { session_id, custom_instructions } = frame;

  const session = ctx.sessions.get(session_id);
  if (!session) {
    sendFrame(ws, { type: "ack", session_id, ok: false, error: "Session not found", request_id: ctx.requestId });
    return;
  }
  if (session.status === "stopped" || session.status === "error") {
    sendFrame(ws, { type: "ack", session_id, ok: false, error: "Session has stopped", request_id: ctx.requestId });
    return;
  }

  const sent = ctx.bridge.sendCompact(session_id, custom_instructions, ctx.requestId);
  sendFrame(ws, { type: "ack", session_id, ok: sent, request_id: ctx.requestId, ...(!sent ? { error: "Runner not connected" } : {}) });
}

// --- Helpers ---

function sendFrame(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

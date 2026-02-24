import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { SessionManager } from "./sessions.js";
import type { RunnerMessage } from "./types.js";
import { EventEmitter } from "events";
import { logger } from "./logger.js";

export class WsBridge extends EventEmitter {
  private wss: WebSocketServer;
  private connections = new Map<string, WebSocket>();
  private shuttingDown = false;

  constructor(private sessions: SessionManager, port: number) {
    super();
    this.setMaxListeners(100);
    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", (_ws: WebSocket, _req: IncomingMessage) => {
      let sessionId: string | undefined;
      const ws = _ws;

      ws.on("message", (data: Buffer) => {
        let msg: RunnerMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          logger.warn("orchestrator.ws_bridge", "invalid_json_from_runner");
          return;
        }

        if (!sessionId && msg.session_id) {
          sessionId = msg.session_id;
          this.connections.set(sessionId, ws);
          this.sessions.setWs(sessionId, ws);
          logger.info("orchestrator.ws_bridge", "runner_connected", { session_id: sessionId });
        }

        if (!sessionId) return;

        switch (msg.type) {
          case "status":
            logger.debug("orchestrator.ws_bridge", "runner_status", {
              session_id: sessionId,
              status: msg.status,
              request_id: msg.request_id,
              trace_id: msg.trace_id,
            });
            this.sessions.updateStatus(sessionId, msg.status);
            this.emit(`status:${sessionId}`, msg.status);
            break;

          case "session_init":
            logger.info("orchestrator.ws_bridge", "runner_session_init", {
              session_id: sessionId,
              sdk_session_id: msg.sdk_session_id,
              request_id: msg.request_id,
              trace_id: msg.trace_id,
            });
            if (msg.sdk_session_id) {
              this.sessions.setSdkSessionId(sessionId, msg.sdk_session_id);
              this.emit(`session_init:${sessionId}`, msg.sdk_session_id);
            }
            break;

          case "event":
            logger.debug("orchestrator.ws_bridge", "runner_event", {
              session_id: sessionId,
              event_type: msg.event?.type,
              event_subtype: msg.event?.subtype,
              request_id: msg.request_id,
              trace_id: msg.trace_id,
            });
            this.emit(`event:${sessionId}`, msg.event);
            break;

          case "error":
            logger.error("orchestrator.ws_bridge", "runner_error", {
              session_id: sessionId,
              code: msg.code,
              message: msg.message,
              request_id: msg.request_id,
              trace_id: msg.trace_id,
            });
            this.sessions.setError(sessionId, msg.message);
            this.emit(`error:${sessionId}`, msg.code, msg.message);
            break;

          default:
            logger.warn("orchestrator.ws_bridge", "unhandled_runner_message_type", {
              session_id: sessionId,
              type: (msg as any).type,
            });
        }
      });

      ws.on("close", () => {
        if (sessionId) {
          logger.info("orchestrator.ws_bridge", "runner_disconnected", { session_id: sessionId });
          this.connections.delete(sessionId);
          const session = this.sessions.get(sessionId);
          if (session) {
            this.sessions.clearRuntime(sessionId);
            if (!this.shuttingDown && session.status !== "stopped" && session.status !== "error") {
              this.sessions.updateStatus(sessionId, "stopped");
              this.emit(`status:${sessionId}`, "stopped");
            }
          }
        }
      });

      ws.on("error", (err: Error) => {
        logger.error("orchestrator.ws_bridge", "runner_ws_error", {
          session_id: sessionId,
          error: err.message,
        });
      });
    });

    logger.info("orchestrator.ws_bridge", "listening", { port });
  }

  sendMessage(
    sessionId: string,
    message: string,
    overrides?: { model?: string; maxTurns?: number; requestId?: string; traceId?: string }
  ): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "session_not_connected", { session_id: sessionId });
      return false;
    }

    ws.send(JSON.stringify({
      type: "message",
      message,
      ...overrides,
    }));
    logger.debug("orchestrator.ws_bridge", "forwarded_message_to_runner", {
      session_id: sessionId,
      message_preview: message.slice(0, 120),
      request_id: overrides?.requestId,
      trace_id: overrides?.traceId,
      overrides,
    });
    return true;
  }

  sendShutdown(sessionId: string): void {
    const ws = this.connections.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "shutdown" }));
      logger.debug("orchestrator.ws_bridge", "sent_shutdown", { session_id: sessionId });
      return;
    }
    logger.debug("orchestrator.ws_bridge", "shutdown_skipped_no_connection", { session_id: sessionId });
  }

  isConnected(sessionId: string): boolean {
    const ws = this.connections.get(sessionId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.shuttingDown = true;
    this.wss.close();
  }
}

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { SessionManager } from "./sessions.js";
import type { RunnerMessage, ContextOperation, RunnerContextResultMessage, RunnerContextSnapshotMessage } from "./types.js";
import type Database from "better-sqlite3";
import { insertSnapshot } from "./db.js";
import { EventEmitter } from "events";
import { logger } from "./logger.js";

export class WsBridge extends EventEmitter {
  private wss: WebSocketServer;
  private connections = new Map<string, WebSocket>();
  private shuttingDown = false;

  private db: Database.Database | null = null;

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
            this.emit("status", sessionId, msg.status);
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

          case "context_state":
            logger.debug("orchestrator.ws_bridge", "runner_context_state", {
              session_id: sessionId,
              context_tokens: (msg as any).context_tokens,
              compacted: (msg as any).compacted,
            });
            this.sessions.updateContextTokens(sessionId, (msg as any).context_tokens);
            if ((msg as any).compacted) {
              this.sessions.incrementCompactCount(sessionId);
            }
            this.emit(`context_state:${sessionId}`, (msg as any).context_tokens, (msg as any).compacted);
            this.emit("context_state", sessionId, (msg as any).context_tokens, (msg as any).compacted);
            break;

          case "context_result":
            logger.debug("orchestrator.ws_bridge", "runner_context_result", {
              session_id: sessionId,
              success: (msg as any).success,
              request_id: (msg as any).request_id,
            });
            this.emit(`context_result:${sessionId}:${(msg as any).request_id}`, msg);
            break;

          case "permission_request":
            logger.debug("orchestrator.ws_bridge", "runner_permission_request", {
              session_id: sessionId,
              tool_name: (msg as any).tool_name,
              tool_use_id: (msg as any).tool_use_id,
            });
            this.emit(`permission_request:${sessionId}`, msg);
            break;

          case "commands_result":
            logger.debug("orchestrator.ws_bridge", "runner_commands_result", {
              session_id: sessionId,
              count: (msg as any).commands?.length ?? 0,
              request_id: (msg as any).request_id,
            });
            this.emit(`commands_result:${sessionId}:${(msg as any).request_id}`, msg);
            break;

          case "context_snapshot": {
            const snap = msg as RunnerContextSnapshotMessage;
            logger.info("orchestrator.ws_bridge", "runner_context_snapshot", {
              session_id: sessionId,
              trigger: snap.trigger,
              message_count: snap.message_count,
            });
            if (this.db) {
              try {
                insertSnapshot(
                  this.db,
                  sessionId,
                  snap.trigger,
                  snap.message_count,
                  snap.roles,
                  snap.messages,
                  snap.request_id,
                );
              } catch (dbErr) {
                logger.error("orchestrator.ws_bridge", "snapshot_insert_failed", {
                  session_id: sessionId,
                  error: dbErr instanceof Error ? dbErr.message : String(dbErr),
                });
              }
            }
            this.emit(`context_snapshot:${sessionId}`, snap);
            break;
          }

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
    overrides?: { content?: any[]; model?: string; maxTurns?: number; maxThinkingTokens?: number; requestId?: string; traceId?: string }
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

  sendCompact(sessionId: string, customInstructions?: string, requestId?: string): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "session_not_connected_for_compact", { session_id: sessionId });
      return false;
    }
    ws.send(JSON.stringify({
      type: "compact",
      ...(customInstructions ? { custom_instructions: customInstructions } : {}),
      request_id: requestId,
    }));
    logger.debug("orchestrator.ws_bridge", "sent_compact_command", { session_id: sessionId, request_id: requestId });
    return true;
  }

  sendSteer(
    sessionId: string,
    message: string,
    options?: {
      content?: any[];
      model?: string;
      maxTurns?: number;
      maxThinkingTokens?: number;
      compact?: boolean;
      compactInstructions?: string;
      operations?: ContextOperation[];
      requestId?: string;
      traceId?: string;
    },
  ): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "session_not_connected_for_steer", { session_id: sessionId });
      return false;
    }
    ws.send(JSON.stringify({
      type: "steer",
      message,
      ...(options?.content ? { content: options.content } : {}),
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.maxTurns ? { maxTurns: options.maxTurns } : {}),
      ...(options?.maxThinkingTokens ? { maxThinkingTokens: options.maxThinkingTokens } : {}),
      ...(options?.compact ? { compact: options.compact } : {}),
      ...(options?.compactInstructions ? { compact_instructions: options.compactInstructions } : {}),
      ...(options?.operations ? { operations: options.operations } : {}),
      request_id: options?.requestId,
      trace_id: options?.traceId,
    }));
    logger.debug("orchestrator.ws_bridge", "sent_steer_command", {
      session_id: sessionId,
      message_preview: message.slice(0, 120),
      operations_count: options?.operations?.length ?? 0,
      request_id: options?.requestId,
    });
    return true;
  }

  sendForkAndSteer(
    sessionId: string,
    message: string,
    options?: {
      content?: any[];
      model?: string;
      maxTurns?: number;
      maxThinkingTokens?: number;
      requestId?: string;
      traceId?: string;
    },
  ): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "session_not_connected_for_fork_and_steer", { session_id: sessionId });
      return false;
    }
    ws.send(JSON.stringify({
      type: "fork_and_steer",
      message,
      ...(options?.content ? { content: options.content } : {}),
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.maxTurns ? { maxTurns: options.maxTurns } : {}),
      ...(options?.maxThinkingTokens ? { maxThinkingTokens: options.maxThinkingTokens } : {}),
      request_id: options?.requestId,
      trace_id: options?.traceId,
    }));
    logger.debug("orchestrator.ws_bridge", "sent_fork_and_steer_command", {
      session_id: sessionId,
      message_preview: message.slice(0, 120),
      request_id: options?.requestId,
    });
    return true;
  }

  sendContextCommand(
    sessionId: string,
    operation: ContextOperation,
    requestId: string,
    traceId?: string,
  ): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "session_not_connected_for_context", { session_id: sessionId });
      return false;
    }
    ws.send(JSON.stringify({
      type: "context",
      operation,
      request_id: requestId,
      trace_id: traceId,
    }));
    logger.debug("orchestrator.ws_bridge", "sent_context_command", { session_id: sessionId, op: operation.op, request_id: requestId });
    return true;
  }

  waitForContextResult(
    sessionId: string,
    requestId: string,
    timeoutMs = 30_000,
  ): Promise<RunnerContextResultMessage> {
    return new Promise((resolve, reject) => {
      const eventKey = `context_result:${sessionId}:${requestId}`;
      const timer = setTimeout(() => {
        this.removeListener(eventKey, onResult);
        reject(new Error("Timed out waiting for context operation result"));
      }, timeoutMs);

      const onResult = (msg: RunnerContextResultMessage) => {
        clearTimeout(timer);
        this.removeListener(eventKey, onResult);
        resolve(msg);
      };
      this.on(eventKey, onResult);
    });
  }

  sendRewind(sessionId: string, userMessageUuid: string, requestId?: string, traceId?: string): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "session_not_connected_for_rewind", { session_id: sessionId });
      return false;
    }
    ws.send(JSON.stringify({
      type: "rewind",
      user_message_uuid: userMessageUuid,
      request_id: requestId,
      trace_id: traceId,
    }));
    logger.debug("orchestrator.ws_bridge", "sent_rewind_command", {
      session_id: sessionId,
      user_message_uuid: userMessageUuid,
      request_id: requestId,
    });
    return true;
  }

  sendSetOptions(
    sessionId: string,
    options: {
      model?: string;
      maxThinkingTokens?: number;
      compactInstructions?: string;
      requestId?: string;
      traceId?: string;
    },
  ): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "session_not_connected_for_set_options", { session_id: sessionId });
      return false;
    }
    ws.send(JSON.stringify({
      type: "set_options",
      ...(options.model ? { model: options.model } : {}),
      ...(options.maxThinkingTokens ? { maxThinkingTokens: options.maxThinkingTokens } : {}),
      ...(options.compactInstructions ? { compact_instructions: options.compactInstructions } : {}),
      request_id: options.requestId,
      trace_id: options.traceId,
    }));
    logger.debug("orchestrator.ws_bridge", "sent_set_options_command", {
      session_id: sessionId,
      request_id: options.requestId,
    });
    return true;
  }

  sendPermissionResponse(
    sessionId: string,
    toolUseId: string,
    behavior: string,
    message?: string,
    updatedInput?: any,
  ): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "session_not_connected_for_permission_response", { session_id: sessionId });
      return false;
    }
    ws.send(JSON.stringify({
      type: "permission_response",
      tool_use_id: toolUseId,
      behavior,
      ...(message ? { message } : {}),
      ...(updatedInput !== undefined ? { updated_input: updatedInput } : {}),
    }));
    logger.debug("orchestrator.ws_bridge", "sent_permission_response", {
      session_id: sessionId,
      tool_use_id: toolUseId,
      behavior,
    });
    return true;
  }

  sendGetCommands(sessionId: string, requestId?: string, traceId?: string): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "session_not_connected_for_get_commands", { session_id: sessionId });
      return false;
    }
    ws.send(JSON.stringify({
      type: "get_commands",
      request_id: requestId,
      trace_id: traceId,
    }));
    return true;
  }

  /** Wait for a commands_result from the runner (one-shot, with timeout). */
  waitForCommandsResult(sessionId: string, requestId: string, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      const eventKey = `commands_result:${sessionId}:${requestId}`;
      const timer = setTimeout(() => {
        this.removeListener(eventKey, onResult);
        reject(new Error("Timed out waiting for commands result"));
      }, timeoutMs);

      const onResult = (msg: any) => {
        clearTimeout(timer);
        this.removeListener(eventKey, onResult);
        resolve(msg);
      };
      this.on(eventKey, onResult);
    });
  }

  /** Rekey a connection from one session ID to another (used by warm pool adoption). */
  rekeyConnection(oldId: string, newId: string): boolean {
    const ws = this.connections.get(oldId);
    if (!ws) return false;
    this.connections.delete(oldId);
    this.connections.set(newId, ws);
    this.sessions.setWs(newId, ws);
    logger.info("orchestrator.ws_bridge", "rekey_connection", { old_id: oldId, new_id: newId });
    return true;
  }

  /** Send an adopt command to a warm runner container. */
  sendAdopt(
    warmId: string,
    realId: string,
    oauthToken: string,
    config: Record<string, any>,
  ): boolean {
    const ws = this.connections.get(warmId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("orchestrator.ws_bridge", "adopt_target_not_connected", { warm_id: warmId });
      return false;
    }
    ws.send(JSON.stringify({
      type: "adopt",
      session_id: realId,
      oauth_token: oauthToken,
      config,
    }));
    logger.info("orchestrator.ws_bridge", "sent_adopt_command", { warm_id: warmId, real_id: realId });
    return true;
  }

  /** Attach a database reference for persisting snapshots. */
  setDb(db: Database.Database): void {
    this.db = db;
  }

  close(): void {
    this.shuttingDown = true;
    this.wss.close();
  }
}

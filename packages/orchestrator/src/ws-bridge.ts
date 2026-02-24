import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { SessionManager } from "./sessions.js";
import type { RunnerMessage, RunnerEvent } from "./types.js";
import { EventEmitter } from "events";

export class WsBridge extends EventEmitter {
  private wss: WebSocketServer;
  private connections = new Map<string, WebSocket>();

  constructor(private sessions: SessionManager, port: number) {
    super();
    this.setMaxListeners(100);
    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
      let sessionId: string | undefined;

      ws.on("message", (data: Buffer) => {
        let msg: RunnerMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (!sessionId && msg.session_id) {
          sessionId = msg.session_id;
          this.connections.set(sessionId, ws);

          const session = this.sessions.get(sessionId);
          if (session) {
            session.ws = ws;
          }

          console.log(`Runner connected for session ${sessionId}`);
        }

        if (!sessionId) return;

        switch (msg.type) {
          case "status":
            this.sessions.updateStatus(sessionId, msg.status);
            this.emit(`status:${sessionId}`, msg.status);
            break;

          case "event":
            this.emit(`event:${sessionId}`, msg.event);
            break;

          case "error":
            this.sessions.setError(sessionId, msg.message);
            this.emit(`error:${sessionId}`, msg.code, msg.message);
            break;
        }
      });

      ws.on("close", () => {
        if (sessionId) {
          console.log(`Runner disconnected for session ${sessionId}`);
          this.connections.delete(sessionId);
          const session = this.sessions.get(sessionId);
          if (session) {
            session.ws = undefined;
            if (session.status !== "stopped" && session.status !== "error") {
              this.sessions.updateStatus(sessionId, "stopped");
              this.emit(`status:${sessionId}`, "stopped");
            }
          }
        }
      });

      ws.on("error", (err: Error) => {
        console.error(`Runner WS error (session ${sessionId}):`, err.message);
      });
    });

    console.log(`WS bridge listening on :${port}`);
  }

  sendMessage(sessionId: string, message: string, overrides?: { model?: string; maxTurns?: number }): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    ws.send(JSON.stringify({
      type: "message",
      message,
      ...overrides,
    }));
    return true;
  }

  sendShutdown(sessionId: string): void {
    const ws = this.connections.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "shutdown" }));
    }
  }

  isConnected(sessionId: string): boolean {
    const ws = this.connections.get(sessionId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.wss.close();
  }
}

import { createConnection, type Socket } from "net";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";

/**
 * Drop-in replacement for SDKSession that communicates over the sdk-ipc
 * Unix socket instead of stdin/stdout pipes. Implements the same interface
 * used by run-turn.ts and command-handler.ts:
 *
 *   session.send(message)
 *   session.stream()
 *   session.close()
 *   (session as any).query.setModel(...)
 *   (session as any).query.interrupt()
 *   etc.
 */
export class SdkIpcSession {
  private socket: Socket | null = null;
  private buffer = "";
  private connected = false;
  private closed = false;

  /** Events received from the outbound tap, waiting to be consumed by stream() */
  private eventQueue: any[] = [];
  /** Resolvers for stream() consumers waiting for the next event */
  private waiters: Array<(event: any) => void> = [];
  /** Pending control request responses keyed by request_id */
  private pendingControls = new Map<string, {
    resolve: (response: any) => void;
    reject: (error: Error) => void;
  }>();

  /** Session ID acquired from the init event */
  sessionId: string | undefined;

  readonly query: SdkIpcQuery;

  constructor() {
    this.query = new SdkIpcQuery(this);
  }

  /** Connect to the sdk-ipc Unix socket with retries. */
  async connect(socketPath: string, retries = 60, delayMs = 300): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.tryConnect(socketPath);
        logger.info("runner.sdk-ipc", "connected", { socket: socketPath, attempt });
        return;
      } catch (err) {
        if (attempt === retries) {
          throw new Error(
            `Failed to connect to sdk-ipc socket ${socketPath} after ${retries + 1} attempts: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  private tryConnect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(socketPath, () => {
        this.socket = sock;
        this.connected = true;
        this.buffer = "";
        resolve();
      });

      sock.on("data", (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            this.handleEvent(JSON.parse(line));
          } catch (e) {
            logger.warn("runner.sdk-ipc", "parse_error", { line: line.slice(0, 200) });
          }
        }
      });

      sock.on("error", (err) => {
        if (!this.connected) {
          reject(err);
          return;
        }
        logger.warn("runner.sdk-ipc", "socket_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.connected = false;
      });

      sock.on("close", () => {
        this.connected = false;
        // Wake any waiting stream consumers with a done signal
        for (const w of this.waiters) {
          w(null);
        }
        this.waiters = [];
      });
    });
  }

  private handleEvent(event: any): void {
    // Capture session_id from init event
    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      if (!this.sessionId) {
        this.sessionId = event.session_id;
      }
    }

    // Route control responses to pending promises
    if (event.type === "control_response") {
      const reqId = event.response?.request_id;
      const pending = reqId ? this.pendingControls.get(reqId) : undefined;
      if (pending) {
        this.pendingControls.delete(reqId);
        if (event.response?.subtype === "error") {
          pending.reject(new Error(event.response.error || "Control request failed"));
        } else {
          pending.resolve(event.response?.response ?? {});
        }
        return;
      }
    }

    // All other events go to the stream queue
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(event);
    } else {
      this.eventQueue.push(event);
    }
  }

  /** Send a user message (same interface as SDKSession.send). */
  async send(message: string | any): Promise<void> {
    if (!this.socket || !this.connected) {
      throw new Error("sdk-ipc not connected");
    }

    let frame: any;
    if (typeof message === "string") {
      frame = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: message }] },
        parent_tool_use_id: null,
        session_id: this.sessionId || "",
        uuid: randomUUID(),
      };
    } else if (message.type === "user") {
      // Already formatted as SDK user message
      frame = message;
    } else {
      // Assume it's a content array or similar
      frame = {
        type: "user",
        message: message.message || { role: "user", content: message },
        parent_tool_use_id: message.parent_tool_use_id || null,
        session_id: message.session_id || this.sessionId || "",
        uuid: message.uuid || randomUUID(),
      };
    }

    this.socket.write(JSON.stringify(frame) + "\n");
  }

  /** Yield events until a "result" type event (same interface as SDKSession.stream). */
  async *stream(): AsyncGenerator<any, void, undefined> {
    while (true) {
      let event: any;

      if (this.eventQueue.length > 0) {
        event = this.eventQueue.shift();
      } else {
        event = await new Promise<any>((resolve) => {
          this.waiters.push(resolve);
        });
      }

      // null = socket closed
      if (event === null) return;

      yield event;

      if (event.type === "result") return;
    }
  }

  /** Send a control request and await the response. */
  async sendControl(request: any): Promise<any> {
    if (!this.socket || !this.connected) {
      throw new Error("sdk-ipc not connected");
    }

    const requestId = randomUUID();
    const frame = {
      type: "control_request",
      request_id: requestId,
      request,
    };

    return new Promise<any>((resolve, reject) => {
      this.pendingControls.set(requestId, { resolve, reject });
      this.socket!.write(JSON.stringify(frame) + "\n");

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingControls.has(requestId)) {
          this.pendingControls.delete(requestId);
          reject(new Error(`Control request timed out: ${request.subtype}`));
        }
      }, 30000);
    });
  }

  /** Close the session. */
  close(): void {
    this.closed = true;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
    for (const w of this.waiters) {
      w(null);
    }
    this.waiters = [];
    for (const [, pending] of this.pendingControls) {
      pending.reject(new Error("Session closed"));
    }
    this.pendingControls.clear();
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Query object that mirrors the SDK's internal g9 class interface.
 * All methods used by run-turn.ts and command-handler.ts are implemented.
 */
class SdkIpcQuery {
  constructor(private session: SdkIpcSession) {}

  async interrupt(): Promise<void> {
    await this.session.sendControl({ subtype: "interrupt" });
  }

  async setModel(model: string): Promise<void> {
    await this.session.sendControl({ subtype: "set_model", model });
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.session.sendControl({ subtype: "set_permission_mode", mode });
  }

  async setMaxThinkingTokens(maxThinkingTokens: number): Promise<void> {
    await this.session.sendControl({ subtype: "set_max_thinking_tokens", max_thinking_tokens: maxThinkingTokens });
  }

  async setMcpServers(servers: Record<string, any>): Promise<any> {
    return this.session.sendControl({ subtype: "mcp_set_servers", servers: Object.entries(servers).map(([name, config]) => ({ name, ...config })) });
  }

  async mcpServerStatus(): Promise<any> {
    return this.session.sendControl({ subtype: "mcp_status" });
  }

  async reconnectMcpServer(serverName: string): Promise<void> {
    await this.session.sendControl({ subtype: "mcp_reconnect", serverName });
  }

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    await this.session.sendControl({ subtype: "mcp_toggle", serverName, enabled });
  }

  async enableRemoteControl(enabled: boolean): Promise<any> {
    return this.session.sendControl({ subtype: "remote_control", enabled });
  }

  async rename(title: string): Promise<void> {
    await this.session.sendControl({ subtype: "generate_session_title", description: title, persist: true });
  }

  async supportedCommands(): Promise<any[]> {
    return [];
  }
}

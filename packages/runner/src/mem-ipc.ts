import { createConnection, type Socket } from "net";
import { logger } from "./logger.js";

/**
 * IPC client for the memory-ipc patch's Unix socket server.
 * Speaks line-delimited JSON over a Unix domain socket to read/mutate
 * the live mutableMessages array inside the Claude CLI process.
 */
export class MemIpcClient {
  private socket: Socket | null = null;
  private buffer = "";
  private pending: Array<{
    resolve: (value: any) => void;
    reject: (reason: any) => void;
  }> = [];
  private connected = false;

  /** Connect to the IPC socket with retries. */
  async connect(socketPath: string, retries = 30, delayMs = 200): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.tryConnect(socketPath);
        logger.info("runner.ipc", "connected", { socket: socketPath, attempt });
        return;
      } catch (err) {
        if (attempt === retries) {
          throw new Error(
            `Failed to connect to IPC socket ${socketPath} after ${retries + 1} attempts: ${err instanceof Error ? err.message : String(err)}`
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
          const pending = this.pending.shift();
          if (pending) {
            try {
              pending.resolve(JSON.parse(line));
            } catch (e) {
              pending.reject(new Error(`Invalid JSON from IPC: ${line.slice(0, 200)}`));
            }
          }
        }
      });

      sock.on("error", (err) => {
        if (!this.connected) {
          reject(err);
          return;
        }
        // Reject all pending requests on connection error
        for (const p of this.pending) {
          p.reject(err);
        }
        this.pending = [];
        this.connected = false;
      });

      sock.on("close", () => {
        this.connected = false;
        for (const p of this.pending) {
          p.reject(new Error("IPC socket closed"));
        }
        this.pending = [];
      });
    });
  }

  /** Send a command and wait for the response. */
  private send<T = any>(cmd: Record<string, any>): Promise<T> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error("IPC not connected"));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket!.write(JSON.stringify(cmd) + "\n");
    });
  }

  /** Disconnect from the IPC socket. */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      for (const p of this.pending) {
        p.reject(new Error("IPC disconnected"));
      }
      this.pending = [];
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // --- IPC Commands ---

  async getLength(): Promise<number> {
    const res = await this.send({ cmd: "get_length" });
    if (!res.ok) throw new Error(res.error);
    return res.length;
  }

  async getMessages(start?: number, end?: number): Promise<any[]> {
    const res = await this.send({ cmd: "get_messages", start, end });
    if (!res.ok) throw new Error(res.error);
    return res.messages;
  }

  async getRoles(): Promise<string[]> {
    const res = await this.send({ cmd: "get_roles" });
    if (!res.ok) throw new Error(res.error);
    return res.roles;
  }

  async splice(
    start: number,
    deleteCount: number,
    items?: any[],
  ): Promise<{ removed: any[]; length: number }> {
    const res = await this.send({ cmd: "splice", start, deleteCount, items });
    if (!res.ok) throw new Error(res.error);
    return { removed: res.removed, length: res.length };
  }

  async push(messages: any[]): Promise<number> {
    const res = await this.send({ cmd: "push", messages });
    if (!res.ok) throw new Error(res.error);
    return res.length;
  }

  async pop(count = 1): Promise<any[]> {
    const res = await this.send({ cmd: "pop", count });
    if (!res.ok) throw new Error(res.error);
    return res.removed;
  }

  async clear(): Promise<void> {
    const res = await this.send({ cmd: "clear" });
    if (!res.ok) throw new Error(res.error);
  }

  async set(messages: any[]): Promise<number> {
    const res = await this.send({ cmd: "set", messages });
    if (!res.ok) throw new Error(res.error);
    return res.length;
  }

  async emit(event: any): Promise<void> {
    const res = await this.send({ cmd: "emit", event });
    if (!res.ok) throw new Error(res.error);
  }

  async sessionId(): Promise<string | null> {
    const res = await this.send({ cmd: "session_id" });
    if (!res.ok) throw new Error(res.error);
    return res.id;
  }
}

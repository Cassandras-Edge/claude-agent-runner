import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "http";
import { WebSocket } from "ws";
import { EventEmitter } from "events";
import Database from "better-sqlite3";
import { attachClientWs } from "../client-ws.js";
import { SessionManager } from "../sessions.js";
import { openDb } from "../db.js";

// --- Helpers ---

function createMockBridge() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  return Object.assign(emitter, {
    sendMessage: vi.fn().mockReturnValue(true),
    sendShutdown: vi.fn(),
    sendCompact: vi.fn().mockReturnValue(true),
    sendSteer: vi.fn().mockReturnValue(true),
    sendForkAndSteer: vi.fn().mockReturnValue(true),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn(),
  });
}

type MockBridge = ReturnType<typeof createMockBridge>;

function startServer(bridge: MockBridge, sessions: SessionManager): Promise<{ port: number; cleanup: () => Promise<void> }> {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = attachClientWs(httpServer, { bridge, sessions } as any);

    httpServer.listen(0, () => {
      const addr = httpServer.address() as { port: number };
      resolve({
        port: addr.port,
        cleanup: () =>
          new Promise<void>((res) => {
            wss.close();
            httpServer.close(() => res());
          }),
      });
    });
  });
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function sendFrame(ws: WebSocket, frame: any): void {
  ws.send(JSON.stringify(frame));
}

function waitForFrame(ws: WebSocket, predicate?: (frame: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for frame")), 3000);
    const onMessage = (data: Buffer) => {
      const frame = JSON.parse(data.toString());
      if (!predicate || predicate(frame)) {
        clearTimeout(timer);
        ws.removeListener("message", onMessage);
        resolve(frame);
      }
    };
    ws.on("message", onMessage);
  });
}

// --- Tests ---

describe("Client WebSocket", () => {
  let db: Database.Database;
  let sessions: SessionManager;
  let bridge: MockBridge;
  let port: number;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    db = openDb(":memory:");
    sessions = new SessionManager(db);
    bridge = createMockBridge();

    const server = await startServer(bridge, sessions);
    port = server.port;
    cleanup = server.cleanup;
  });

  afterEach(async () => {
    await cleanup();
    db.close();
  });

  describe("connection lifecycle", () => {
    it("connects on /ws path", async () => {
      const ws = await connectWs(port);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it("rejects connections on non-/ws paths", async () => {
      await expect(
        new Promise<void>((_, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
          ws.on("error", reject);
          ws.on("close", () => reject(new Error("closed")));
        }),
      ).rejects.toBeDefined();
    });
  });

  describe("ping/pong", () => {
    it("responds to ping with pong", async () => {
      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "ping" });
      const frame = await responsePromise;
      expect(frame.type).toBe("pong");
      ws.close();
    });
  });

  describe("subscribe", () => {
    it("returns subscribed ack with current status", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "subscribe", session_id: "s1", request_id: "req-1" });
      const frame = await responsePromise;

      expect(frame.type).toBe("subscribed");
      expect(frame.session_id).toBe("s1");
      expect(frame.status).toBe("idle");
      expect(frame.request_id).toBe("req-1");
      ws.close();
    });

    it("returns error for unknown session", async () => {
      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "subscribe", session_id: "unknown" });
      const frame = await responsePromise;

      expect(frame.type).toBe("error");
      expect(frame.error_code).toBe("session_not_found");
      ws.close();
    });

    it("returns error when already subscribed", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      // First subscribe
      const firstPromise = waitForFrame(ws, (f) => f.type === "subscribed");
      sendFrame(ws, { type: "subscribe", session_id: "s1" });
      await firstPromise;

      // Second subscribe
      const secondPromise = waitForFrame(ws, (f) => f.type === "error");
      sendFrame(ws, { type: "subscribe", session_id: "s1" });
      const frame = await secondPromise;

      expect(frame.type).toBe("error");
      expect(frame.message).toContain("Already subscribed");
      ws.close();
    });

    it("forwards status events to subscribed clients", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      // Subscribe first
      const subPromise = waitForFrame(ws, (f) => f.type === "subscribed");
      sendFrame(ws, { type: "subscribe", session_id: "s1" });
      await subPromise;

      // Now emit a status change from bridge
      const statusPromise = waitForFrame(ws, (f) => f.type === "status");
      bridge.emit("status:s1", "busy");
      const frame = await statusPromise;

      expect(frame.type).toBe("status");
      expect(frame.session_id).toBe("s1");
      expect(frame.status).toBe("busy");
      ws.close();
    });

    it("forwards event events to subscribed clients", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      const subPromise = waitForFrame(ws, (f) => f.type === "subscribed");
      sendFrame(ws, { type: "subscribe", session_id: "s1" });
      await subPromise;

      const eventPromise = waitForFrame(ws, (f) => f.type === "event");
      bridge.emit("event:s1", { type: "assistant", content: [{ type: "text", text: "Hello" }] });
      const frame = await eventPromise;

      expect(frame.type).toBe("event");
      expect(frame.session_id).toBe("s1");
      expect(frame.event.type).toBe("assistant");
      ws.close();
    });

    it("forwards error events to subscribed clients", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      const subPromise = waitForFrame(ws, (f) => f.type === "subscribed");
      sendFrame(ws, { type: "subscribe", session_id: "s1" });
      await subPromise;

      const errorPromise = waitForFrame(ws, (f) => f.type === "error");
      bridge.emit("error:s1", "agent_error", "Something broke");
      const frame = await errorPromise;

      expect(frame.type).toBe("error");
      expect(frame.session_id).toBe("s1");
      expect(frame.error_code).toBe("agent_error");
      expect(frame.message).toBe("Something broke");
      ws.close();
    });

    it("forwards context_state events to subscribed clients", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      const subPromise = waitForFrame(ws, (f) => f.type === "subscribed");
      sendFrame(ws, { type: "subscribe", session_id: "s1" });
      await subPromise;

      const ctxPromise = waitForFrame(ws, (f) => f.type === "context_state");
      bridge.emit("context_state:s1", 12345, false);
      const frame = await ctxPromise;

      expect(frame.type).toBe("context_state");
      expect(frame.session_id).toBe("s1");
      expect(frame.context_tokens).toBe(12345);
      ws.close();
    });
  });

  describe("unsubscribe", () => {
    it("stops forwarding events after unsubscribe", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      // Subscribe
      const subPromise = waitForFrame(ws, (f) => f.type === "subscribed");
      sendFrame(ws, { type: "subscribe", session_id: "s1" });
      await subPromise;

      // Unsubscribe
      sendFrame(ws, { type: "unsubscribe", session_id: "s1" });

      // Wait a tick for unsubscribe to process
      await new Promise((r) => setTimeout(r, 50));

      // Emit an event — should NOT be forwarded
      bridge.emit("status:s1", "busy");

      // Send a ping to verify we get pong but no status
      const pongPromise = waitForFrame(ws, (f) => f.type === "pong");
      sendFrame(ws, { type: "ping" });
      const frame = await pongPromise;
      expect(frame.type).toBe("pong");
      ws.close();
    });

    it("returns error when not subscribed", async () => {
      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "unsubscribe", session_id: "s1" });
      const frame = await responsePromise;

      expect(frame.type).toBe("error");
      expect(frame.message).toContain("Not subscribed");
      ws.close();
    });
  });

  describe("send", () => {
    it("dispatches message to bridge and returns ack", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, {
        type: "send",
        session_id: "s1",
        message: "Hello agent",
        model: "opus",
        request_id: "req-send",
      });
      const frame = await responsePromise;

      expect(frame.type).toBe("ack");
      expect(frame.ok).toBe(true);
      expect(frame.session_id).toBe("s1");
      expect(frame.request_id).toBe("req-send");

      expect(bridge.sendMessage).toHaveBeenCalledWith("s1", "Hello agent", expect.objectContaining({
        model: "opus",
        requestId: "req-send",
      }));
      ws.close();
    });

    it("increments message count", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "send", session_id: "s1", message: "hi" });
      await responsePromise;

      expect(sessions.get("s1")!.messageCount).toBe(1);
      ws.close();
    });

    it("returns ack with ok=false for unknown session", async () => {
      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "send", session_id: "unknown", message: "hi" });
      const frame = await responsePromise;

      expect(frame.type).toBe("ack");
      expect(frame.ok).toBe(false);
      expect(frame.error).toContain("not found");
      ws.close();
    });

    it("returns ack with ok=false for busy session", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "busy");

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "send", session_id: "s1", message: "hi" });
      const frame = await responsePromise;

      expect(frame.type).toBe("ack");
      expect(frame.ok).toBe(false);
      expect(frame.error).toContain("busy");
      ws.close();
    });

    it("returns ack with ok=false for stopped session", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "stopped");

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "send", session_id: "s1", message: "hi" });
      const frame = await responsePromise;

      expect(frame.type).toBe("ack");
      expect(frame.ok).toBe(false);
      expect(frame.error).toContain("stopped");
      ws.close();
    });

    it("returns ack with ok=false when runner is disconnected", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");
      bridge.sendMessage.mockReturnValueOnce(false);

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "send", session_id: "s1", message: "hi" });
      const frame = await responsePromise;

      expect(frame.type).toBe("ack");
      expect(frame.ok).toBe(false);
      expect(frame.error).toContain("not connected");
      ws.close();
    });
  });

  describe("steer", () => {
    it("dispatches steer to bridge and returns ack", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "busy");

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, {
        type: "steer",
        session_id: "s1",
        message: "New direction",
        mode: "steer",
        request_id: "req-steer",
      });
      const frame = await responsePromise;

      expect(frame.type).toBe("ack");
      expect(frame.ok).toBe(true);
      expect(bridge.sendSteer).toHaveBeenCalledWith("s1", "New direction", expect.objectContaining({
        requestId: "req-steer",
      }));
      ws.close();
    });

    it("dispatches fork_and_steer mode", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "busy");

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, {
        type: "steer",
        session_id: "s1",
        message: "Fork it",
        mode: "fork_and_steer",
        request_id: "req-fork",
      });
      const frame = await responsePromise;

      expect(frame.type).toBe("ack");
      expect(frame.ok).toBe(true);
      expect(bridge.sendForkAndSteer).toHaveBeenCalledWith("s1", "Fork it", expect.objectContaining({
        requestId: "req-fork",
      }));
      ws.close();
    });

    it("returns ack with ok=false for stopped session", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "stopped");

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "steer", session_id: "s1", message: "hi" });
      const frame = await responsePromise;

      expect(frame.type).toBe("ack");
      expect(frame.ok).toBe(false);
      ws.close();
    });
  });

  describe("compact", () => {
    it("dispatches compact to bridge and returns ack", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, {
        type: "compact",
        session_id: "s1",
        custom_instructions: "Be concise",
        request_id: "req-compact",
      });
      const frame = await responsePromise;

      expect(frame.type).toBe("ack");
      expect(frame.ok).toBe(true);
      expect(bridge.sendCompact).toHaveBeenCalledWith("s1", "Be concise", "req-compact");
      ws.close();
    });
  });

  describe("unknown frame type", () => {
    it("returns error for unknown frame type", async () => {
      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      sendFrame(ws, { type: "bogus" });
      const frame = await responsePromise;

      expect(frame.type).toBe("error");
      expect(frame.message).toContain("Unknown frame type");
      ws.close();
    });
  });

  describe("invalid JSON", () => {
    it("returns error for unparseable input", async () => {
      const ws = await connectWs(port);
      const responsePromise = waitForFrame(ws);
      ws.send("not json {{{");
      const frame = await responsePromise;

      expect(frame.type).toBe("error");
      expect(frame.message).toContain("Invalid JSON");
      ws.close();
    });
  });

  describe("connection cleanup on close", () => {
    it("cleans up subscriptions when client disconnects", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");

      const ws = await connectWs(port);
      // Subscribe
      const subPromise = waitForFrame(ws, (f) => f.type === "subscribed");
      sendFrame(ws, { type: "subscribe", session_id: "s1" });
      await subPromise;

      // Verify bridge has listeners
      expect(bridge.listenerCount("status:s1")).toBeGreaterThan(0);

      // Close connection
      ws.close();
      await new Promise((r) => setTimeout(r, 100));

      // Verify bridge listeners are cleaned up
      expect(bridge.listenerCount("status:s1")).toBe(0);
      expect(bridge.listenerCount("event:s1")).toBe(0);
      expect(bridge.listenerCount("error:s1")).toBe(0);
      expect(bridge.listenerCount("context_state:s1")).toBe(0);
    });
  });

  describe("multiple subscriptions", () => {
    it("supports subscribing to multiple sessions", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "idle");
      sessions.create("s2", "c2", 0, { model: "sonnet" });
      sessions.updateStatus("s2", "ready");

      const ws = await connectWs(port);

      // Subscribe to both
      const sub1Promise = waitForFrame(ws, (f) => f.type === "subscribed" && f.session_id === "s1");
      sendFrame(ws, { type: "subscribe", session_id: "s1" });
      const sub1 = await sub1Promise;
      expect(sub1.status).toBe("idle");

      const sub2Promise = waitForFrame(ws, (f) => f.type === "subscribed" && f.session_id === "s2");
      sendFrame(ws, { type: "subscribe", session_id: "s2" });
      const sub2 = await sub2Promise;
      expect(sub2.status).toBe("ready");

      // Emit events for both sessions
      const status1Promise = waitForFrame(ws, (f) => f.type === "status" && f.session_id === "s1");
      bridge.emit("status:s1", "busy");
      const status1 = await status1Promise;
      expect(status1.status).toBe("busy");

      const status2Promise = waitForFrame(ws, (f) => f.type === "status" && f.session_id === "s2");
      bridge.emit("status:s2", "busy");
      const status2 = await status2Promise;
      expect(status2.status).toBe("busy");

      ws.close();
    });
  });
});

/**
 * Integration tests for the client-facing WebSocket API.
 *
 * These exercise the full pipeline:
 *   client WS  →  orchestrator (HTTP + client-ws)  →  WsBridge  →  fake runner WS
 *
 * No Docker, no real Claude — just the orchestrator internals wired together
 * with a fake runner that speaks the runner WS protocol.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer as createHttpServer } from "http";
import { WebSocket } from "ws";
import Database from "better-sqlite3";
import { attachClientWs } from "../client-ws.js";
import { WsBridge } from "../ws-bridge.js";
import { SessionManager } from "../sessions.js";
import { openDb } from "../db.js";

// --- Fake Runner ---

/** Simulates a runner container connecting to the WsBridge. */
class FakeRunner {
  private ws!: WebSocket;
  private received: any[] = [];

  constructor(
    private bridgePort: number,
    private sessionId: string,
  ) {}

  /** Connect to bridge and register with a status message. */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.bridgePort}`);
      this.ws.on("open", () => {
        // Register with bridge by sending initial status
        this.ws.send(JSON.stringify({
          type: "status",
          session_id: this.sessionId,
          status: "ready",
        }));
        resolve();
      });
      this.ws.on("error", reject);
      this.ws.on("message", (data: Buffer) => {
        this.received.push(JSON.parse(data.toString()));
      });
    });
  }

  /** Wait for a command from the orchestrator (via bridge). */
  waitForCommand(predicate?: (cmd: any) => boolean, timeoutMs = 3000): Promise<any> {
    // Check already-received
    const idx = this.received.findIndex((c) => !predicate || predicate(c));
    if (idx >= 0) return Promise.resolve(this.received.splice(idx, 1)[0]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.removeListener("message", onMsg);
        reject(new Error("FakeRunner: timed out waiting for command"));
      }, timeoutMs);
      const onMsg = (data: Buffer) => {
        const cmd = JSON.parse(data.toString());
        if (!predicate || predicate(cmd)) {
          clearTimeout(timer);
          this.ws.removeListener("message", onMsg);
          resolve(cmd);
        } else {
          this.received.push(cmd);
        }
      };
      this.ws.on("message", onMsg);
    });
  }

  /** Send an event back to the orchestrator (as the runner would). */
  sendEvent(event: any): void {
    this.ws.send(JSON.stringify({
      type: "event",
      session_id: this.sessionId,
      event,
    }));
  }

  /** Send a status update. */
  sendStatus(status: string): void {
    this.ws.send(JSON.stringify({
      type: "status",
      session_id: this.sessionId,
      status,
    }));
  }

  /** Send an error. */
  sendError(code: string, message: string): void {
    this.ws.send(JSON.stringify({
      type: "error",
      session_id: this.sessionId,
      code,
      message,
    }));
  }

  /** Send a context_state update. */
  sendContextState(contextTokens: number, compacted = false): void {
    this.ws.send(JSON.stringify({
      type: "context_state",
      session_id: this.sessionId,
      context_tokens: contextTokens,
      compacted,
    }));
  }

  close(): void {
    this.ws.close();
  }
}

// --- Client Helpers ---

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function send(ws: WebSocket, frame: any): void {
  ws.send(JSON.stringify(frame));
}

function waitFor(ws: WebSocket, predicate?: (f: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", onMsg);
      reject(new Error("Client: timed out waiting for frame"));
    }, timeoutMs);
    const onMsg = (data: Buffer) => {
      const frame = JSON.parse(data.toString());
      if (!predicate || predicate(frame)) {
        clearTimeout(timer);
        ws.removeListener("message", onMsg);
        resolve(frame);
      }
    };
    ws.on("message", onMsg);
  });
}

function collectFrames(ws: WebSocket, count: number, timeoutMs = 3000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const frames: any[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timed out: collected ${frames.length}/${count} frames`)),
      timeoutMs,
    );
    const onMsg = (data: Buffer) => {
      frames.push(JSON.parse(data.toString()));
      if (frames.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", onMsg);
        resolve(frames);
      }
    };
    ws.on("message", onMsg);
  });
}

// Small sleep for event propagation
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// --- Test Harness ---

interface Harness {
  db: Database.Database;
  sessions: SessionManager;
  bridge: WsBridge;
  bridgePort: number;
  httpPort: number;
  cleanup: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const db = openDb(":memory:");
  const sessions = new SessionManager(db);

  // Find free ports by binding to 0
  const bridgePort = await new Promise<number>((resolve) => {
    const tmp = createHttpServer();
    tmp.listen(0, () => {
      const port = (tmp.address() as any).port;
      tmp.close(() => resolve(port));
    });
  });

  const bridge = new WsBridge(sessions, bridgePort);
  bridge.setDb(db);

  const httpServer = createHttpServer();
  const clientWss = attachClientWs(httpServer, { bridge, sessions } as any);

  const httpPort = await new Promise<number>((resolve) => {
    httpServer.listen(0, () => {
      resolve((httpServer.address() as any).port);
    });
  });

  return {
    db,
    sessions,
    bridge,
    bridgePort,
    httpPort,
    cleanup: async () => {
      clientWss.close();
      bridge.close();
      await new Promise<void>((r) => httpServer.close(() => r()));
      // Wait for all WS close events to propagate before closing DB
      await new Promise((r) => setTimeout(r, 100));
      db.close();
    },
  };
}

// --- Integration Tests ---

describe("Client WS Integration", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  describe("full send→event→result pipeline", () => {
    it("client sends message, receives streamed events and result from runner", async () => {
      // 1. Create session in DB
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      // 2. Fake runner connects to bridge, sends ready status
      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();
      // Bridge should have set status to ready
      expect(h.sessions.get("s1")!.status).toBe("ready");

      // 3. Client connects and subscribes
      const client = await connectClient(h.httpPort);
      const subAck = waitFor(client, (f) => f.type === "subscribed");
      send(client, { type: "subscribe", session_id: "s1" });
      const subFrame = await subAck;
      expect(subFrame.status).toBe("ready");

      // 4. Client sends a message
      const ackPromise = waitFor(client, (f) => f.type === "ack");
      send(client, {
        type: "send",
        session_id: "s1",
        message: "What is 2+2?",
        request_id: "req-1",
      });

      // 5. Verify ack
      const ack = await ackPromise;
      expect(ack.ok).toBe(true);
      expect(ack.request_id).toBe("req-1");

      // 6. Verify runner received the message command
      const cmd = await runner.waitForCommand((c) => c.type === "message");
      expect(cmd.message).toBe("What is 2+2?");

      // 7. Runner sends back events — client should receive them
      // Collect: status→busy + assistant event + result event
      const framesPromise = collectFrames(client, 3);

      runner.sendStatus("busy");
      runner.sendEvent({
        type: "assistant",
        content: [{ type: "text", text: "4" }],
      });
      runner.sendEvent({
        type: "result",
        subtype: "success",
        result: "The answer is 4.",
        usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001, duration_ms: 100 },
      });

      const frames = await framesPromise;

      // Verify status frame
      const statusFrame = frames.find((f) => f.type === "status");
      expect(statusFrame).toBeDefined();
      expect(statusFrame.status).toBe("busy");

      // Verify event frames
      const eventFrames = frames.filter((f) => f.type === "event");
      expect(eventFrames).toHaveLength(2);
      expect(eventFrames[0].event.type).toBe("assistant");
      expect(eventFrames[0].event.content[0].text).toBe("4");
      expect(eventFrames[1].event.type).toBe("result");
      expect(eventFrames[1].event.subtype).toBe("success");

      // 8. Verify message count incremented
      expect(h.sessions.get("s1")!.messageCount).toBe(1);

      runner.close();
      client.close();
    });
  });

  describe("subscribe to in-progress session", () => {
    it("client subscribes mid-stream and receives subsequent events", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();

      // Runner transitions to busy (simulating already processing)
      runner.sendStatus("busy");
      await tick();
      expect(h.sessions.get("s1")!.status).toBe("busy");

      // Client connects and subscribes to the busy session
      const client = await connectClient(h.httpPort);
      const subAck = waitFor(client, (f) => f.type === "subscribed");
      send(client, { type: "subscribe", session_id: "s1" });
      const subFrame = await subAck;
      expect(subFrame.status).toBe("busy");

      // Runner continues streaming — client should get these
      const eventPromise = waitFor(client, (f) => f.type === "event");
      runner.sendEvent({ type: "assistant", content: [{ type: "text", text: "hello" }] });
      const frame = await eventPromise;
      expect(frame.event.content[0].text).toBe("hello");

      runner.close();
      client.close();
    });
  });

  describe("multiple clients watching same session", () => {
    it("both clients receive events", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();

      const client1 = await connectClient(h.httpPort);
      const client2 = await connectClient(h.httpPort);

      // Both subscribe
      const sub1 = waitFor(client1, (f) => f.type === "subscribed");
      const sub2 = waitFor(client2, (f) => f.type === "subscribed");
      send(client1, { type: "subscribe", session_id: "s1" });
      send(client2, { type: "subscribe", session_id: "s1" });
      await Promise.all([sub1, sub2]);

      // Runner emits an event
      const ev1 = waitFor(client1, (f) => f.type === "event");
      const ev2 = waitFor(client2, (f) => f.type === "event");
      runner.sendEvent({ type: "assistant", content: [{ type: "text", text: "hi" }] });

      const [frame1, frame2] = await Promise.all([ev1, ev2]);
      expect(frame1.event.content[0].text).toBe("hi");
      expect(frame2.event.content[0].text).toBe("hi");

      runner.close();
      client1.close();
      client2.close();
    });
  });

  describe("steer via client WS", () => {
    it("sends steer command to runner and client gets ack", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();

      // Transition to busy
      runner.sendStatus("busy");
      await tick();

      const client = await connectClient(h.httpPort);

      // Send steer
      const ackPromise = waitFor(client, (f) => f.type === "ack");
      send(client, {
        type: "steer",
        session_id: "s1",
        message: "Actually, do this instead",
        mode: "steer",
        request_id: "req-steer",
      });
      const ack = await ackPromise;
      expect(ack.ok).toBe(true);

      // Verify runner received the steer command
      const cmd = await runner.waitForCommand((c) => c.type === "steer");
      expect(cmd.message).toBe("Actually, do this instead");
      expect(cmd.request_id).toBe("req-steer");

      runner.close();
      client.close();
    });

    it("sends fork_and_steer command to runner", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();
      runner.sendStatus("busy");
      await tick();

      const client = await connectClient(h.httpPort);

      const ackPromise = waitFor(client, (f) => f.type === "ack");
      send(client, {
        type: "steer",
        session_id: "s1",
        message: "Fork and do something else",
        mode: "fork_and_steer",
        model: "opus",
        request_id: "req-fork",
      });
      const ack = await ackPromise;
      expect(ack.ok).toBe(true);

      const cmd = await runner.waitForCommand((c) => c.type === "fork_and_steer");
      expect(cmd.message).toBe("Fork and do something else");
      expect(cmd.model).toBe("opus");

      runner.close();
      client.close();
    });
  });

  describe("compact via client WS", () => {
    it("sends compact command to runner", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();

      const client = await connectClient(h.httpPort);

      const ackPromise = waitFor(client, (f) => f.type === "ack");
      send(client, {
        type: "compact",
        session_id: "s1",
        custom_instructions: "Summarize code only",
        request_id: "req-compact",
      });
      const ack = await ackPromise;
      expect(ack.ok).toBe(true);

      const cmd = await runner.waitForCommand((c) => c.type === "compact");
      expect(cmd.custom_instructions).toBe("Summarize code only");
      expect(cmd.request_id).toBe("req-compact");

      runner.close();
      client.close();
    });
  });

  describe("context_state forwarding", () => {
    it("forwards context token updates to subscribed client", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();

      const client = await connectClient(h.httpPort);
      const subAck = waitFor(client, (f) => f.type === "subscribed");
      send(client, { type: "subscribe", session_id: "s1" });
      await subAck;

      const ctxPromise = waitFor(client, (f) => f.type === "context_state");
      runner.sendContextState(42000, true);
      const frame = await ctxPromise;

      expect(frame.context_tokens).toBe(42000);
      expect(frame.compacted).toBe(true);
      expect(frame.session_id).toBe("s1");

      // Verify session manager also updated
      expect(h.sessions.get("s1")!.contextTokens).toBe(42000);

      runner.close();
      client.close();
    });
  });

  describe("error forwarding", () => {
    it("forwards runner errors to subscribed client", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();

      const client = await connectClient(h.httpPort);
      const subAck = waitFor(client, (f) => f.type === "subscribed");
      send(client, { type: "subscribe", session_id: "s1" });
      await subAck;

      const errorPromise = waitFor(client, (f) => f.type === "error");
      runner.sendError("agent_error", "Tool execution failed: permission denied");
      const frame = await errorPromise;

      expect(frame.error_code).toBe("agent_error");
      expect(frame.message).toBe("Tool execution failed: permission denied");

      runner.close();
      client.close();
    });
  });

  describe("runner disconnect", () => {
    it("forwards stopped status to subscribed client when runner disconnects", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();

      const client = await connectClient(h.httpPort);
      const subAck = waitFor(client, (f) => f.type === "subscribed");
      send(client, { type: "subscribe", session_id: "s1" });
      await subAck;

      // Runner disconnects unexpectedly
      const statusPromise = waitFor(client, (f) => f.type === "status" && f.status === "stopped");
      runner.close();
      const frame = await statusPromise;

      expect(frame.session_id).toBe("s1");
      expect(frame.status).toBe("stopped");

      // Session should be marked stopped
      await tick(100);
      expect(h.sessions.get("s1")!.status).toBe("stopped");

      client.close();
    });
  });

  describe("unsubscribe isolation", () => {
    it("client stops receiving events after unsubscribe but can still send commands", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });

      const runner = new FakeRunner(h.bridgePort, "s1");
      await runner.connect();
      await tick();

      const client = await connectClient(h.httpPort);
      const subAck = waitFor(client, (f) => f.type === "subscribed");
      send(client, { type: "subscribe", session_id: "s1" });
      await subAck;

      // Unsubscribe
      send(client, { type: "unsubscribe", session_id: "s1" });
      await tick();

      // Runner emits event — should NOT arrive at client
      runner.sendEvent({ type: "assistant", content: [{ type: "text", text: "ghost" }] });
      await tick(100);

      // Verify by sending a ping — we should get pong, not the event
      const pong = waitFor(client, (f) => f.type === "pong");
      send(client, { type: "ping" });
      const frame = await pong;
      expect(frame.type).toBe("pong");

      // But client can still send commands (just no subscription events)
      const ackPromise = waitFor(client, (f) => f.type === "ack");
      send(client, { type: "send", session_id: "s1", message: "fire-and-forget" });
      const ack = await ackPromise;
      expect(ack.ok).toBe(true);

      runner.close();
      client.close();
    });
  });

  describe("multi-session workflow", () => {
    it("client subscribes to two sessions with different runners", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });
      h.sessions.create("s2", "container-2", 0, { model: "opus" });

      const runner1 = new FakeRunner(h.bridgePort, "s1");
      const runner2 = new FakeRunner(h.bridgePort, "s2");
      await runner1.connect();
      await runner2.connect();
      await tick();

      const client = await connectClient(h.httpPort);

      // Subscribe to both
      const sub1 = waitFor(client, (f) => f.type === "subscribed" && f.session_id === "s1");
      send(client, { type: "subscribe", session_id: "s1" });
      await sub1;

      const sub2 = waitFor(client, (f) => f.type === "subscribed" && f.session_id === "s2");
      send(client, { type: "subscribe", session_id: "s2" });
      await sub2;

      // Send messages to both
      const ack1 = waitFor(client, (f) => f.type === "ack" && f.session_id === "s1");
      send(client, { type: "send", session_id: "s1", message: "task A" });
      await ack1;

      const ack2 = waitFor(client, (f) => f.type === "ack" && f.session_id === "s2");
      send(client, { type: "send", session_id: "s2", message: "task B" });
      await ack2;

      // Both runners received their commands
      const cmd1 = await runner1.waitForCommand((c) => c.type === "message");
      expect(cmd1.message).toBe("task A");
      const cmd2 = await runner2.waitForCommand((c) => c.type === "message");
      expect(cmd2.message).toBe("task B");

      // Both runners respond — client receives both, properly tagged by session
      const ev1Promise = waitFor(client, (f) => f.type === "event" && f.session_id === "s1");
      const ev2Promise = waitFor(client, (f) => f.type === "event" && f.session_id === "s2");

      runner1.sendEvent({ type: "result", subtype: "success", result: "A done" });
      runner2.sendEvent({ type: "result", subtype: "success", result: "B done" });

      const [ev1, ev2] = await Promise.all([ev1Promise, ev2Promise]);
      expect(ev1.event.result).toBe("A done");
      expect(ev2.event.result).toBe("B done");

      runner1.close();
      runner2.close();
      client.close();
    });
  });

  describe("send to disconnected runner", () => {
    it("returns ack with ok=false when runner is not connected", async () => {
      h.sessions.create("s1", "container-1", 0, { model: "sonnet" });
      // Note: no runner connects — session exists in DB but no WS connection

      const client = await connectClient(h.httpPort);

      const ackPromise = waitFor(client, (f) => f.type === "ack");
      send(client, { type: "send", session_id: "s1", message: "hello?" });
      const ack = await ackPromise;
      expect(ack.ok).toBe(false);
      expect(ack.error).toBeDefined();

      client.close();
    });
  });
});

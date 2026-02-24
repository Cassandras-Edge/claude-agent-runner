import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { createServer } from "../server.js";
import { SessionManager } from "../sessions.js";
import { TokenPool } from "../token-pool.js";
import { openDb } from "../db.js";
import type { Hono } from "hono";

// --- Mocks ---

function createMockDocker() {
  return {
    checkConnection: vi.fn().mockResolvedValue(true),
    spawn: vi.fn().mockResolvedValue("container-id-123"),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    ensureNetwork: vi.fn().mockResolvedValue(undefined),
    getContainerId: vi.fn().mockReturnValue("container-id-123"),
  };
}

function createMockBridge() {
  const listeners = new Map<string, Function[]>();
  return {
    on: vi.fn((event: string, fn: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(fn);
    }),
    removeListener: vi.fn((event: string, fn: Function) => {
      const fns = listeners.get(event);
      if (fns) {
        const idx = fns.indexOf(fn);
        if (idx >= 0) fns.splice(idx, 1);
      }
    }),
    emit: (event: string, ...args: any[]) => {
      const fns = listeners.get(event) || [];
      for (const fn of fns) fn(...args);
    },
    sendMessage: vi.fn().mockReturnValue(true),
    sendShutdown: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn(),
  };
}

async function jsonResponse(app: Hono, method: string, path: string, body?: any): Promise<{ status: number; json: any }> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await app.request(path, init);
  const json = await res.json();
  return { status: res.status, json };
}

describe("Server Routes", () => {
  let db: Database.Database;
  let sessions: SessionManager;
  let docker: ReturnType<typeof createMockDocker>;
  let bridge: ReturnType<typeof createMockBridge>;
  let tokenPool: TokenPool;
  let app: Hono;
  let tmpSessionsPath: string;

  beforeEach(() => {
    db = openDb(":memory:");
    sessions = new SessionManager(db);
    docker = createMockDocker();
    bridge = createMockBridge();
    tokenPool = new TokenPool("test-token-a,test-token-b");
    tmpSessionsPath = join(tmpdir(), `test-sessions-${Date.now()}`);
    mkdirSync(join(tmpSessionsPath, "projects", "-workspace"), { recursive: true });

    app = createServer({
      sessions,
      docker,
      bridge,
      tokenPool,
      env: {} as Record<string, string>,
      runnerImage: "claude-runner:test",
      network: "test-net",
      sessionsVolume: "test-sessions",
      sessionsPath: tmpSessionsPath,
      wsPort: 9999,
      orchestratorWsUrl: "ws://localhost:9999",
      messageTimeoutMs: 60_000,
      maxActiveSessions: undefined,
      startedAt: new Date("2025-01-01T00:00:00Z"),
    } as any);
  });

  afterEach(() => {
    db.close();
    try { rmSync(tmpSessionsPath, { recursive: true }); } catch {}
  });

  describe("GET /health", () => {
    it("returns health status with active session count", async () => {
      const { status, json } = await jsonResponse(app, "GET", "/health");

      expect(status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.active_sessions).toBe(0);
      expect(json.runner_image).toBe("claude-runner:test");
      expect(json.docker_connected).toBe(true);
      expect(json.token_pool.size).toBe(2);
      expect(json.uptime_ms).toBeGreaterThanOrEqual(0);
    });

    it("reflects docker disconnection", async () => {
      docker.checkConnection.mockResolvedValue(false);
      const { json } = await jsonResponse(app, "GET", "/health");
      expect(json.docker_connected).toBe(false);
    });
  });

  describe("GET /sessions", () => {
    it("returns empty sessions list", async () => {
      const { status, json } = await jsonResponse(app, "GET", "/sessions");
      expect(status).toBe(200);
      expect(json.sessions).toEqual([]);
    });

    it("returns sessions with correct shape", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet", repo: "https://github.com/test/repo", branch: "main" });
      sessions.updateStatus("s1", "ready");

      const { json } = await jsonResponse(app, "GET", "/sessions");
      expect(json.sessions).toHaveLength(1);

      const s = json.sessions[0];
      expect(s.session_id).toBe("s1");
      expect(s.status).toBe("ready");
      expect(s.source.type).toBe("repo");
      expect(s.source.repo).toBe("https://github.com/test/repo");
      expect(s.model).toBe("sonnet");
      expect(s.message_count).toBe(0);
      expect(s.created_at).toBeDefined();
      expect(s.last_activity).toBeDefined();
    });

    it("uses workspace source type when no repo", async () => {
      sessions.create("s1", "c1", 0, { model: "haiku", workspace: "/my/project" });

      const { json } = await jsonResponse(app, "GET", "/sessions");
      expect(json.sessions[0].source.type).toBe("workspace");
      expect(json.sessions[0].source.workspace).toBe("/my/project");
    });
  });

  describe("GET /sessions/:id", () => {
    it("returns session detail", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet", repo: "https://github.com/test/repo" });
      sessions.updateStatus("s1", "ready");

      const { status, json } = await jsonResponse(app, "GET", "/sessions/s1");
      expect(status).toBe(200);
      expect(json.session_id).toBe("s1");
      expect(json.container_id).toBe("c1");
      expect(json.total_usage).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    });

    it("returns 404 for unknown session", async () => {
      const { status, json } = await jsonResponse(app, "GET", "/sessions/unknown");
      expect(status).toBe(404);
      expect(json.code).toBe("session_not_found");
    });
  });

  describe("PATCH /sessions/:id", () => {
    it("returns 404 for unknown session", async () => {
      const { status, json } = await jsonResponse(app, "PATCH", "/sessions/unknown", { name: "new-name" });
      expect(status).toBe(404);
      expect(json.code).toBe("session_not_found");
    });

    it("updates session name", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });

      const { status, json } = await jsonResponse(app, "PATCH", "/sessions/s1", { name: "new-name" });
      expect(status).toBe(200);
      expect(json.name).toBe("new-name");
      expect(sessions.get("s1")!.name).toBe("new-name");
    });

    it("updates pinned state", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });

      const { status, json } = await jsonResponse(app, "PATCH", "/sessions/s1", { pinned: true });
      expect(status).toBe(200);
      expect(json.pinned).toBe(true);
      expect(sessions.get("s1")!.pinned).toBe(true);
    });

    it("requires at least one supported field", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      const { status, json } = await jsonResponse(app, "PATCH", "/sessions/s1", {});
      expect(status).toBe(400);
      expect(json.code).toBe("invalid_request");
    });

    it("rejects non-boolean pinned", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      const { status, json } = await jsonResponse(app, "PATCH", "/sessions/s1", { pinned: "yes" });
      expect(status).toBe(400);
      expect(json.code).toBe("invalid_request");
    });
  });

  describe("DELETE /sessions/:id", () => {
    it("stops and removes a session", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });

      const { status, json } = await jsonResponse(app, "DELETE", "/sessions/s1");
      expect(status).toBe(200);
      expect(json.session_id).toBe("s1");
      expect(json.status).toBe("stopped");

      expect(bridge.sendShutdown).toHaveBeenCalledWith("s1");
      expect(docker.kill).toHaveBeenCalledWith("s1");
      expect(sessions.get("s1")).toBeUndefined();
    });

    it("returns 404 for unknown session", async () => {
      const { status, json } = await jsonResponse(app, "DELETE", "/sessions/unknown");
      expect(status).toBe(404);
      expect(json.code).toBe("session_not_found");
    });
  });

  describe("POST /sessions", () => {
    it("rejects requests without repo or workspace", async () => {
      const { status, json } = await jsonResponse(app, "POST", "/sessions", { message: "hello" });
      expect(status).toBe(400);
      expect(json.code).toBe("invalid_request");
      expect(json.message).toContain("repo or workspace");
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{{",
      });
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe("invalid_request");
    });

    it("rejects non-boolean pinned", async () => {
      const { status, json } = await jsonResponse(app, "POST", "/sessions", {
        repo: "https://github.com/test/repo",
        pinned: "true",
      });
      expect(status).toBe(400);
      expect(json.code).toBe("invalid_request");
    });

    it("returns 429 when max active session capacity is reached and nothing is evictable", async () => {
      const cappedApp = createServer({
        sessions,
        docker,
        bridge,
        tokenPool,
        env: {} as Record<string, string>,
        runnerImage: "claude-runner:test",
        network: "test-net",
        sessionsVolume: "test-sessions",
        sessionsPath: tmpSessionsPath,
        wsPort: 9999,
        orchestratorWsUrl: "ws://localhost:9999",
        messageTimeoutMs: 60_000,
        maxActiveSessions: 1,
        startedAt: new Date("2025-01-01T00:00:00Z"),
      } as any);

      sessions.create("s1", "c1", 0, { model: "sonnet", pinned: true });
      sessions.updateStatus("s1", "busy");

      const { status, json } = await jsonResponse(cappedApp, "POST", "/sessions", { workspace: "/tmp/workspace" });
      expect(status).toBe(429);
      expect(json.code).toBe("session_capacity_reached");
    });

    it("evicts least-recently-active unpinned ready/idle sessions when at capacity", async () => {
      const cappedApp = createServer({
        sessions,
        docker,
        bridge,
        tokenPool,
        env: {} as Record<string, string>,
        runnerImage: "claude-runner:test",
        network: "test-net",
        sessionsVolume: "test-sessions",
        sessionsPath: tmpSessionsPath,
        wsPort: 9999,
        orchestratorWsUrl: "ws://localhost:9999",
        messageTimeoutMs: 60_000,
        maxActiveSessions: 1,
        startedAt: new Date("2025-01-01T00:00:00Z"),
      } as any);

      const assigned = tokenPool.assign("s-evict");
      sessions.create("s-evict", "c-evict", assigned.tokenIndex, { model: "sonnet" });
      sessions.updateStatus("s-evict", "idle");
      db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run("2025-01-01T00:00:00.000Z", "s-evict");

      docker.spawn.mockRejectedValueOnce(new Error("container failed"));

      const { status } = await jsonResponse(cappedApp, "POST", "/sessions", { workspace: "/tmp/workspace" });
      expect(status).toBe(500);
      expect(bridge.sendShutdown).toHaveBeenCalledWith("s-evict");
      expect(docker.kill).toHaveBeenCalledWith("s-evict");
      expect(sessions.get("s-evict")!.status).toBe("stopped");
      expect(tokenPool.get("s-evict")).toBeUndefined();
    });
  });

  describe("POST /sessions/:id/messages", () => {
    it("returns 404 for unknown session", async () => {
      const { status, json } = await jsonResponse(app, "POST", "/sessions/unknown/messages", { message: "hi" });
      expect(status).toBe(404);
      expect(json.code).toBe("session_not_found");
    });

    it("returns 409 when session is busy", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "busy");

      const { status, json } = await jsonResponse(app, "POST", "/sessions/s1/messages", { message: "hi" });
      expect(status).toBe(409);
      expect(json.code).toBe("session_busy");
    });

    it("returns 410 when session is stopped", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "stopped");

      const { status, json } = await jsonResponse(app, "POST", "/sessions/s1/messages", { message: "hi" });
      expect(status).toBe(410);
      expect(json.code).toBe("session_stopped");
    });

    it("returns 410 when session is in error state", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.setError("s1", "crashed");

      const { status, json } = await jsonResponse(app, "POST", "/sessions/s1/messages", { message: "hi" });
      expect(status).toBe(410);
      expect(json.code).toBe("session_stopped");
    });

    it("rejects missing message field", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "ready");

      const { status, json } = await jsonResponse(app, "POST", "/sessions/s1/messages", {});
      expect(status).toBe(400);
      expect(json.code).toBe("invalid_request");
      expect(json.message).toContain("message");
    });

    it("rejects invalid JSON", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "ready");

      const res = await app.request("/sessions/s1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe("invalid_request");
    });
  });

  describe("POST /sessions/:id/messages/stream", () => {
    it("returns 404 for unknown session", async () => {
      const { status, json } = await jsonResponse(app, "POST", "/sessions/unknown/messages/stream", { message: "hi" });
      expect(status).toBe(404);
      expect(json.code).toBe("session_not_found");
    });

    it("returns 409 when session is busy", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "busy");

      const { status, json } = await jsonResponse(app, "POST", "/sessions/s1/messages/stream", { message: "hi" });
      expect(status).toBe(409);
      expect(json.code).toBe("session_busy");
    });
  });

  describe("GET /sessions/:id/transcript", () => {
    it("returns 404 for unknown session", async () => {
      const { status, json } = await jsonResponse(app, "GET", "/sessions/unknown/transcript");
      expect(status).toBe(404);
      expect(json.code).toBe("session_not_found");
    });

    it("returns 404 when transcript file does not exist yet", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });

      const { status, json } = await jsonResponse(app, "GET", "/sessions/s1/transcript");
      expect(status).toBe(404);
      expect(json.message).toContain("not yet available");
    });

    it("returns raw JSONL by default", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });

      // Write a fake JSONL transcript
      const transcriptPath = join(tmpSessionsPath, "projects", "-workspace", "s1.jsonl");
      const lines = [
        JSON.stringify({ type: "assistant", content: "Hello" }),
        JSON.stringify({ type: "result", subtype: "success" }),
      ].join("\n");
      writeFileSync(transcriptPath, lines + "\n");

      const res = await app.request("/sessions/s1/transcript", { method: "GET" });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
      expect(res.headers.get("X-Session-Id")).toBe("s1");

      const body = await res.text();
      expect(body.trim().split("\n")).toHaveLength(2);
    });

    it("returns parsed JSON array when format=json", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });

      const transcriptPath = join(tmpSessionsPath, "projects", "-workspace", "s1.jsonl");
      const event1 = { type: "assistant", content: "Hi" };
      const event2 = { type: "result", subtype: "success" };
      writeFileSync(transcriptPath, [JSON.stringify(event1), JSON.stringify(event2)].join("\n") + "\n");

      const { status, json } = await jsonResponse(app, "GET", "/sessions/s1/transcript?format=json");
      expect(status).toBe(200);
      expect(json.session_id).toBe("s1");
      expect(json.events).toHaveLength(2);
      expect(json.events[0].type).toBe("assistant");
      expect(json.events[1].type).toBe("result");
    });
  });

  describe("DELETE /sessions/:id releases token", () => {
    it("releases the token from the pool on delete", async () => {
      // Assign a token through the pool
      tokenPool.assign("s1");
      expect(tokenPool.get("s1")).toBeDefined();

      sessions.create("s1", "c1", 0, { model: "sonnet" });

      await jsonResponse(app, "DELETE", "/sessions/s1");
      expect(tokenPool.get("s1")).toBeUndefined();
    });
  });
});

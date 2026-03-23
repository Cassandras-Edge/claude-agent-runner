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
    getPodIp: vi.fn().mockResolvedValue("10.100.0.8"),
    rekeySession: vi.fn().mockReturnValue(true),
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
    sendAdopt: vi.fn().mockReturnValue(true),
    rekeyConnection: vi.fn().mockReturnValue(true),
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
      sessions.create("s1", "c1", 0, {
        model: "sonnet",
        repo: "https://github.com/test/repo",
        branch: "main",
        agentId: "agent-a",
      });
      sessions.updateStatus("s1", "ready");

      const { json } = await jsonResponse(app, "GET", "/sessions");
      expect(json.sessions).toHaveLength(1);

      const s = json.sessions[0];
      expect(s.session_id).toBe("s1");
      expect(s.agent_id).toBe("agent-a");
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

    it("uses ephemeral source type when no repo or workspace", async () => {
      sessions.create("s1", "c1", 0, { model: "haiku" });

      const { json } = await jsonResponse(app, "GET", "/sessions");
      expect(json.sessions[0].source.type).toBe("ephemeral");
    });
  });

  describe("GET /sessions/:id", () => {
    it("returns session detail", async () => {
      sessions.create("s1", "c1", 0, {
        model: "sonnet",
        repo: "https://github.com/test/repo",
        agentId: "agent-a",
        forkedFrom: "parent-session",
      });
      sessions.setSdkSessionId("s1", "sdk-123");
      sessions.updateStatus("s1", "ready");

      const { status, json } = await jsonResponse(app, "GET", "/sessions/s1");
      expect(status).toBe(200);
      expect(json.session_id).toBe("s1");
      expect(json.agent_id).toBe("agent-a");
      expect(json.container_id).toBe("c1");
      expect(json.sdk_session_id).toBe("sdk-123");
      expect(json.forked_from).toBe("parent-session");
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

  describe("POST /sessions/:id/stop", () => {
    it("stops a session without deleting its metadata", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "ready");

      const { status, json } = await jsonResponse(app, "POST", "/sessions/s1/stop");

      expect(status).toBe(200);
      expect(json.session_id).toBe("s1");
      expect(json.status).toBe("stopped");
      expect(bridge.sendShutdown).toHaveBeenCalledWith("s1");
      expect(docker.kill).toHaveBeenCalledWith("s1");
      expect(sessions.get("s1")!.status).toBe("stopped");
    });
  });

  describe("POST /sessions/:id/resume", () => {
    it("respawns a stopped session using stored config", async () => {
      sessions.create("s1", "c1", 0, {
        model: "sonnet",
        vaultName: "vault-a",
        agentId: "agent-a",
        systemPrompt: "be helpful",
        maxTurns: 7,
        thinking: true,
        additionalDirectories: ["/tmp/a"],
        compactInstructions: "compact please",
        permissionMode: "default",
        mcpServers: { docs: { type: "http" as const, url: "https://docs.example.com/mcp" } },
        allowedPaths: ["/workspace", "/tmp/a"],
      });
      sessions.setSdkSessionId("s1", "sdk-123");
      sessions.updateStatus("s1", "stopped");

      docker.spawn.mockImplementationOnce(async (config: any) => {
        setTimeout(() => {
          sessions.updateStatus(config.sessionId, "ready");
          bridge.emit(`status:${config.sessionId}`, "ready");
        }, 0);
        return "container-resumed";
      });

      const { status, json } = await jsonResponse(app, "POST", "/sessions/s1/resume");

      expect(status).toBe(200);
      expect(json.session_id).toBe("s1");
      expect(json.status).toBe("ready");
      expect(docker.spawn).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "s1",
        vault: "vault-a",
        model: "sonnet",
        systemPrompt: "be helpful",
        maxTurns: 7,
        thinking: true,
        additionalDirectories: ["/tmp/a"],
        compactInstructions: "compact please",
        permissionMode: "default",
        mcpServers: { docs: { type: "http" as const, url: "https://docs.example.com/mcp" } },
        allowedPaths: ["/workspace", "/tmp/a"],
        sdkSessionId: "sdk-123",
      }));
      expect(sessions.get("s1")!.containerId).toBe("container-resumed");
      expect(sessions.get("s1")!.status).toBe("ready");
    });
  });

  describe("POST /sessions/:id/fork", () => {
    it("inherits persisted session config in the forked child", async () => {
      sessions.create("parent", "c1", 0, {
        model: "sonnet",
        vaultName: "vault-a",
        agentId: "agent-a",
        systemPrompt: "be helpful",
        maxTurns: 7,
        pinned: true,
        thinking: true,
        additionalDirectories: ["/tmp/a"],
        compactInstructions: "compact please",
        permissionMode: "default",
        mcpServers: { docs: { type: "http" as const, url: "https://docs.example.com/mcp" } },
        allowedPaths: ["/workspace", "/tmp/a"],
      });
      sessions.setSdkSessionId("parent", "sdk-parent");
      sessions.updateStatus("parent", "ready");

      docker.spawn.mockImplementationOnce(async (config: any) => {
        setTimeout(() => {
          sessions.updateStatus(config.sessionId, "ready");
          bridge.emit(`status:${config.sessionId}`, "ready");
        }, 0);
        return "container-forked";
      });

      const { status, json } = await jsonResponse(app, "POST", "/sessions/parent/fork", {});

      expect(status).toBe(200);
      expect(json.forked_from).toBe("parent");
      expect(docker.spawn).toHaveBeenCalledWith(expect.objectContaining({
        vault: "vault-a",
        model: "sonnet",
        systemPrompt: "be helpful",
        maxTurns: 7,
        thinking: true,
        additionalDirectories: ["/tmp/a"],
        compactInstructions: "compact please",
        permissionMode: "default",
        mcpServers: { docs: { type: "http" as const, url: "https://docs.example.com/mcp" } },
        allowedPaths: ["/workspace", "/tmp/a"],
        forkFrom: "sdk-parent",
        forkSession: true,
      }));

      const child = sessions.list().find((session) => session.id !== "parent");
      expect(child).toBeDefined();
      expect(child!.vaultName).toBe("vault-a");
      expect(child!.agentId).toBe("agent-a");
      expect(child!.thinking).toBe(true);
      expect(child!.additionalDirectories).toEqual(["/tmp/a"]);
      expect(child!.compactInstructions).toBe("compact please");
      expect(child!.permissionMode).toBe("default");
      expect(child!.allowedPaths).toEqual(["/workspace", "/tmp/a"]);
      expect(child!.forkedFrom).toBe("parent");
      expect(child!.pinned).toBe(true);
    });
  });

  describe("POST /sessions", () => {
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

    it("creates a session successfully when no initial message is provided", async () => {
      docker.spawn.mockImplementation(async (config: any) => {
        setTimeout(() => {
          sessions.updateStatus(config.sessionId, "ready");
          bridge.emit(`status:${config.sessionId}`, "ready");
        }, 0);
        return "container-ready";
      });

      const { status, json } = await jsonResponse(app, "POST", "/sessions", {
        workspace: "/tmp/workspace",
        model: "sonnet",
      });

      expect(status).toBe(200);
      expect(json.status).toBe("ready");
      expect(json.session_id).toBeDefined();

      const session = sessions.get(json.session_id)!;
      expect(session.workspace).toBe("/tmp/workspace");
      expect(session.status).toBe("ready");
      expect(session.containerId).toBe("container-ready");
      expect(tokenPool.get(json.session_id)).toBeDefined();
    });

    it("creates a session and returns the initial message result", async () => {
      docker.spawn.mockImplementation(async (config: any) => {
        setTimeout(() => {
          sessions.updateStatus(config.sessionId, "ready");
          bridge.emit(`status:${config.sessionId}`, "ready");
        }, 0);
        return "container-with-message";
      });
      bridge.sendMessage.mockImplementation((sessionId: string) => {
        setTimeout(() => {
          bridge.emit(`event:${sessionId}`, {
            type: "assistant",
            content: [{ type: "text", text: "draft response" }],
          });
          bridge.emit(`event:${sessionId}`, {
            type: "result",
            subtype: "success",
            result: "final response",
            usage: { input_tokens: 7, output_tokens: 3, cost_usd: 0.12, duration_ms: 45 },
          });
        }, 0);
        return true;
      });

      const { status, json } = await jsonResponse(app, "POST", "/sessions", {
        workspace: "/tmp/workspace",
        model: "sonnet",
        message: "say hello",
      });

      expect(status).toBe(200);
      expect(json.result).toBe("final response");
      expect(json.usage).toEqual({
        input_tokens: 7,
        output_tokens: 3,
        cost_usd: 0.12,
        duration_ms: 45,
      });

      const session = sessions.get(json.session_id)!;
      expect(session.messageCount).toBe(1);
      expect(session.totalUsage).toEqual({
        input_tokens: 7,
        output_tokens: 3,
        cost_usd: 0.12,
      });
    });

    it("uses the warm pool handoff path when a matching runner is available", async () => {
      tokenPool.assign("warm-1");
      bridge.sendAdopt.mockImplementation((_warmId: string, sessionId: string) => {
        setTimeout(() => {
          sessions.updateStatus(sessionId, "ready");
          bridge.emit(`status:${sessionId}`, "ready");
        }, 0);
        return true;
      });

      const warmPool = {
        adopt: vi.fn().mockReturnValue({
          warmId: "warm-1",
          containerId: "warm-container",
          tokenIndex: 0,
          status: "ready",
          spawnedAt: new Date("2025-01-01T00:00:00Z"),
          vault: "vault-a",
          agentId: "agent-a",
        }),
      };

      const warmApp = createServer({
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
        warmPool: warmPool as any,
      } as any);

      const { status, json } = await jsonResponse(warmApp, "POST", "/sessions", {
        vault: "vault-a",
        agentId: "agent-a",
        model: "opus",
      });

      expect(status).toBe(200);
      expect(json.status).toBe("ready");
      expect(warmPool.adopt).toHaveBeenCalledWith("vault-a", "agent-a");
      expect(docker.spawn).not.toHaveBeenCalled();
      expect(bridge.sendAdopt).toHaveBeenCalledWith(
        "warm-1",
        json.session_id,
        expect.any(String),
        expect.objectContaining({ vault: "vault-a", model: "opus" }),
      );
      expect(bridge.rekeyConnection).toHaveBeenCalledWith("warm-1", json.session_id);
      expect(docker.rekeySession).toHaveBeenCalledWith("warm-1", json.session_id);
      expect(sessions.get(json.session_id)!.containerId).toBe("warm-container");
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

    it("returns the runner result for a successful follow-up message", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "ready");
      bridge.sendMessage.mockImplementation((sessionId: string) => {
        setTimeout(() => {
          bridge.emit(`event:${sessionId}`, {
            type: "assistant",
            content: [{ type: "text", text: "partial" }],
          });
          bridge.emit(`event:${sessionId}`, {
            type: "result",
            subtype: "success",
            result: "follow-up result",
            usage: { input_tokens: 4, output_tokens: 2, cost_usd: 0.05, duration_ms: 22 },
          });
        }, 0);
        return true;
      });

      const { status, json } = await jsonResponse(app, "POST", "/sessions/s1/messages", { message: "follow up" });

      expect(status).toBe(200);
      expect(json.result).toBe("follow-up result");
      expect(json.usage).toEqual({
        input_tokens: 4,
        output_tokens: 2,
        cost_usd: 0.05,
        duration_ms: 22,
      });
      expect(sessions.get("s1")!.messageCount).toBe(1);
      expect(sessions.get("s1")!.totalUsage).toEqual({
        input_tokens: 4,
        output_tokens: 2,
        cost_usd: 0.05,
      });
    });

    it("surfaces a non-success runner result as an agent_error response", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });
      sessions.updateStatus("s1", "ready");
      bridge.sendMessage.mockImplementation((sessionId: string) => {
        setTimeout(() => {
          bridge.emit(`event:${sessionId}`, {
            type: "result",
            subtype: "error_max_turns",
            errors: ["too many turns"],
            usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 10 },
          });
        }, 0);
        return true;
      });

      const { status, json } = await jsonResponse(app, "POST", "/sessions/s1/messages", { message: "follow up" });

      expect(status).toBe(500);
      expect(json.code).toBe("agent_error");
      expect(json.message).toContain("too many turns");
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

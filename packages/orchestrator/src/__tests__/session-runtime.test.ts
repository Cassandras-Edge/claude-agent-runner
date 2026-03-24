import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import Database from "better-sqlite3";
import { openDb } from "../db.js";
import { SessionManager } from "../sessions.js";
import { TokenPool } from "../token-pool.js";
import type { AppContext } from "../server/app-context.js";
import {
  categorizeError,
  rollbackSession,
  sendAndCollect,
  spawnSession,
  stopSessionRuntime,
  waitForReady,
} from "../server/services/session-runtime.js";

function createMockDocker() {
  return {
    spawn: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    rekeySession: vi.fn().mockReturnValue(true),
  };
}

function createMockBridge() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  return Object.assign(emitter, {
    sendAdopt: vi.fn().mockReturnValue(true),
    rekeyConnection: vi.fn().mockReturnValue(true),
    sendMessage: vi.fn().mockReturnValue(true),
    sendShutdown: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
  });
}

describe("session-runtime services", () => {
  let db: Database.Database;
  let sessions: SessionManager;
  let docker: ReturnType<typeof createMockDocker>;
  let bridge: ReturnType<typeof createMockBridge>;
  let tokenPool: TokenPool;
  let ctx: AppContext;

  beforeEach(() => {
    db = openDb(":memory:");
    sessions = new SessionManager(db);
    docker = createMockDocker();
    bridge = createMockBridge();
    tokenPool = new TokenPool("token-a,token-b");

    ctx = {
      sessions,
      docker: docker as any,
      bridge: bridge as any,
      tokenPool,
      db,
      env: { GIT_TOKEN: "git-token" },
      runnerImage: "claude-runner:test",
      network: "test-net",
      sessionsVolume: "test-sessions",
      sessionsPath: "/tmp/test-sessions",
      wsPort: 9999,
      orchestratorWsUrl: "ws://localhost:9999",
      messageTimeoutMs: 50,
      startedAt: new Date("2025-01-01T00:00:00Z"),
    };
  });

  afterEach(() => {
    db.close();
  });

  describe("spawnSession", () => {
    it("cold-spawns a session and persists its runtime metadata", async () => {
      docker.spawn.mockResolvedValueOnce("container-123");

      const result = await spawnSession(ctx, "s1", {
        workspace: "/tmp/workspace",
        model: "sonnet",
        systemPrompt: "be helpful",
      });

      expect(result.containerId).toBe("container-123");
      expect(result.session.id).toBe("s1");
      expect(result.session.containerId).toBe("container-123");
      expect(result.session.workspace).toBe("/tmp/workspace");
      expect(result.session.model).toBe("sonnet");
      expect(tokenPool.get("s1")).toBeTruthy();
      expect(docker.spawn).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "s1",
        workspace: "/tmp/workspace",
        model: "sonnet",
        image: "claude-runner:test",
        orchestratorUrl: "ws://localhost:9999",
        network: "test-net",
      }));
    });

    it("rolls back token allocation when cold spawn fails", async () => {
      docker.spawn.mockRejectedValueOnce(new Error("container failed"));

      await expect(
        spawnSession(ctx, "s1", { workspace: "/tmp/workspace", model: "sonnet" }),
      ).rejects.toThrow("container failed");

      expect(sessions.get("s1")).toBeUndefined();
      expect(tokenPool.get("s1")).toBeUndefined();
      expect(docker.kill).not.toHaveBeenCalled();
    });

    it("adopts a warm runner and rekeys bridge and docker state", async () => {
      tokenPool.assign("warm-1");
      const warmEntry = {
        warmId: "warm-1",
        containerId: "warm-container",
        tokenIndex: 0,
        status: "ready" as const,
        spawnedAt: new Date("2025-01-01T00:00:00Z"),
        vault: "vault-a",
        agentId: "agent-a",
      };
      ctx.warmPool = {
        adopt: vi.fn().mockReturnValue(warmEntry),
      } as any;

      const result = await spawnSession(ctx, "s1", {
        vault: "vault-a",
        agentId: "agent-a",
        model: "opus",
        systemPrompt: "fork me",
        message: "one-off query",
      });

      expect(result.containerId).toBe("warm-container");
      expect(docker.spawn).not.toHaveBeenCalled();
      expect(bridge.sendAdopt).toHaveBeenCalledWith(
        "warm-1",
        "s1",
        expect.any(String),
        expect.objectContaining({
          vault: "vault-a",
          model: "opus",
          systemPrompt: "fork me",
          gitToken: "git-token",
        }),
      );
      expect(bridge.rekeyConnection).toHaveBeenCalledWith("warm-1", "s1");
      expect(docker.rekeySession).toHaveBeenCalledWith("warm-1", "s1");
      expect(sessions.get("s1")!.containerId).toBe("warm-container");
      expect(tokenPool.get("warm-1")).toBeUndefined();
      expect(tokenPool.get("s1")).toBeTruthy();
    });
  });

  describe("waitForReady", () => {
    it("resolves when the runner reports ready", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });

      setTimeout(() => {
        bridge.emit("status:s1", "ready");
      }, 0);

      await expect(waitForReady(ctx, "s1", 100)).resolves.toBeUndefined();
    });

    it("rejects when the runner reports an error", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });

      setTimeout(() => {
        bridge.emit("error:s1", "agent_error", "runner exploded");
      }, 0);

      await expect(waitForReady(ctx, "s1", 100)).rejects.toThrow("runner exploded");
    });

    it("rejects on timeout", async () => {
      sessions.create("s1", "c1", 0, { model: "sonnet" });

      await expect(waitForReady(ctx, "s1", 20)).rejects.toThrow("Timed out waiting for runner to be ready");
    });
  });

  describe("sendAndCollect", () => {
    beforeEach(() => {
      const assigned = tokenPool.assign("s1");
      sessions.create("s1", "c1", assigned.tokenIndex, { model: "sonnet" });
    });

    it("collects assistant output, returns result text, and stores usage", async () => {
      bridge.sendMessage.mockImplementationOnce(() => {
        setTimeout(() => {
          bridge.emit("event:s1", {
            type: "assistant",
            content: [{ type: "text", text: "partial answer" }],
          });
          bridge.emit("event:s1", {
            type: "result",
            subtype: "success",
            result: "final answer",
            usage: { input_tokens: 12, output_tokens: 8, cost_usd: 0.42, duration_ms: 123 },
          });
        }, 0);
        return true;
      });

      const result = await sendAndCollect(ctx, "s1", "hello", { requestId: "req-1" });

      expect(result).toEqual({
        text: "final answer",
        usage: { input_tokens: 12, output_tokens: 8, cost_usd: 0.42, duration_ms: 123 },
      });
      expect(sessions.get("s1")!.totalUsage).toEqual({
        input_tokens: 12,
        output_tokens: 8,
        cost_usd: 0.42,
      });
    });

    it("rejects when the runner returns a non-success result", async () => {
      bridge.sendMessage.mockImplementationOnce(() => {
        setTimeout(() => {
          bridge.emit("event:s1", {
            type: "result",
            subtype: "error_max_turns",
            errors: ["too many turns"],
            usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 50 },
          });
        }, 0);
        return true;
      });

      await expect(sendAndCollect(ctx, "s1", "hello")).rejects.toThrow("too many turns");
    });

    it("rejects when the bridge emits a runner error", async () => {
      bridge.sendMessage.mockImplementationOnce(() => {
        setTimeout(() => {
          bridge.emit("error:s1", "agent_error", "permission denied");
        }, 0);
        return true;
      });

      await expect(sendAndCollect(ctx, "s1", "hello")).rejects.toThrow("permission denied");
    });

    it("rejects on timeout when no events arrive", async () => {
      bridge.sendMessage.mockReturnValueOnce(true);

      await expect(sendAndCollect(ctx, "s1", "hello")).rejects.toThrow(
        "Timed out waiting for runner result after 50ms",
      );
    });

    it("rejects immediately when the runner is disconnected", async () => {
      bridge.sendMessage.mockReturnValueOnce(false);

      await expect(sendAndCollect(ctx, "s1", "hello")).rejects.toThrow("Runner not connected");
    });
  });

  describe("cleanup helpers", () => {
    it("rollbackSession shuts down the runner, removes the session, and releases the token", async () => {
      const assigned = tokenPool.assign("s1");
      sessions.create("s1", "c1", assigned.tokenIndex, { model: "sonnet" });

      await rollbackSession(ctx, "s1", "req-rollback");

      expect(bridge.sendShutdown).toHaveBeenCalledWith("s1");
      expect(docker.kill).toHaveBeenCalledWith("s1");
      expect(sessions.get("s1")).toBeUndefined();
      expect(tokenPool.get("s1")).toBeUndefined();
    });

    it("stopSessionRuntime preserves the session record but marks it stopped", async () => {
      const assigned = tokenPool.assign("s1");
      sessions.create("s1", "c1", assigned.tokenIndex, { model: "sonnet" });

      await stopSessionRuntime(ctx, "s1");

      expect(bridge.sendShutdown).toHaveBeenCalledWith("s1");
      expect(docker.kill).toHaveBeenCalledWith("s1");
      expect(sessions.get("s1")!.status).toBe("stopped");
      expect(tokenPool.get("s1")).toBeUndefined();
    });
  });

  describe("categorizeError", () => {
    it("classifies common failure categories", () => {
      expect(categorizeError("git clone Authentication failed")).toBe("clone_failed");
      expect(categorizeError("Container exited unexpectedly")).toBe("container_failed");
      expect(categorizeError("Timed out waiting for runner")).toBe("timeout");
      expect(categorizeError("mystery failure")).toBe("internal");
    });
  });
});

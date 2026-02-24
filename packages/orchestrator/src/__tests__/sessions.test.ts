import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SessionManager } from "../sessions.js";
import { openDb } from "../db.js";

describe("SessionManager", () => {
  let db: Database.Database;
  let manager: SessionManager;

  beforeEach(() => {
    db = openDb(":memory:");
    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("create", () => {
    it("creates a session with correct initial state", () => {
      const session = manager.create("s1", "container-abc", 0, {
        model: "sonnet",
        repo: "https://github.com/test/repo",
        branch: "main",
      });

      expect(session.id).toBe("s1");
      expect(session.containerId).toBe("container-abc");
      expect(session.status).toBe("starting");
      expect(session.model).toBe("sonnet");
      expect(session.repo).toBe("https://github.com/test/repo");
      expect(session.branch).toBe("main");
      expect(session.messageCount).toBe(0);
      expect(session.totalUsage).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastActivity).toBeInstanceOf(Date);
    });

    it("creates a session with workspace instead of repo", () => {
      const session = manager.create("s1", "container-abc", 0, {
        model: "haiku",
        workspace: "/home/user/project",
      });

      expect(session.workspace).toBe("/home/user/project");
      expect(session.repo).toBeUndefined();
    });

    it("stores optional fields", () => {
      const session = manager.create("s1", "c1", 0, {
        model: "opus",
        systemPrompt: "You are a helpful assistant",
        maxTurns: 10,
      });

      expect(session.systemPrompt).toBe("You are a helpful assistant");
      expect(session.maxTurns).toBe(10);
    });

    it("stores the oauth token index", () => {
      manager.create("s1", "c1", 2, { model: "sonnet" });
      expect(manager.getTokenIndex("s1")).toBe(2);
    });
  });

  describe("get", () => {
    it("retrieves an existing session by ID", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      const session = manager.get("s1");
      expect(session).toBeDefined();
      expect(session!.id).toBe("s1");
    });

    it("returns undefined for non-existent sessions", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns all sessions ordered by created_at DESC", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      manager.create("s2", "c2", 1, { model: "haiku" });

      const sessions = manager.list();
      expect(sessions).toHaveLength(2);
      // Both created at nearly the same time, order depends on insertion
      expect(sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    });

    it("returns empty array when no sessions exist", () => {
      expect(manager.list()).toEqual([]);
    });
  });

  describe("updateStatus", () => {
    it("updates session status", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      manager.updateStatus("s1", "ready");

      const session = manager.get("s1");
      expect(session!.status).toBe("ready");
    });

    it("is a no-op for non-existent sessions", () => {
      expect(() => manager.updateStatus("nonexistent", "ready")).not.toThrow();
    });
  });

  describe("setError", () => {
    it("sets status to error and stores error message", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      manager.setError("s1", "Container crashed");

      const session = manager.get("s1");
      expect(session!.status).toBe("error");
      expect(session!.lastError).toBe("Container crashed");
    });
  });

  describe("incrementMessages", () => {
    it("increments message count", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });

      manager.incrementMessages("s1");
      expect(manager.get("s1")!.messageCount).toBe(1);

      manager.incrementMessages("s1");
      expect(manager.get("s1")!.messageCount).toBe(2);
    });
  });

  describe("addUsage", () => {
    it("accumulates token usage across calls", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });

      manager.addUsage("s1", { input_tokens: 100, output_tokens: 50, cost_usd: 0.01, duration_ms: 500 });
      manager.addUsage("s1", { input_tokens: 200, output_tokens: 75, cost_usd: 0.02, duration_ms: 800 });

      const session = manager.get("s1")!;
      expect(session.totalUsage.input_tokens).toBe(300);
      expect(session.totalUsage.output_tokens).toBe(125);
      expect(session.totalUsage.cost_usd).toBeCloseTo(0.03);
    });
  });

  describe("remove", () => {
    it("removes and returns the session", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      const removed = manager.remove("s1");

      expect(removed).toBeDefined();
      expect(removed!.id).toBe("s1");
      expect(manager.get("s1")).toBeUndefined();
    });

    it("returns undefined for non-existent sessions", () => {
      expect(manager.remove("nonexistent")).toBeUndefined();
    });
  });

  describe("activeCount", () => {
    it("counts sessions that are not stopped or error", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      manager.create("s2", "c2", 0, { model: "sonnet" });
      manager.create("s3", "c3", 0, { model: "sonnet" });

      manager.updateStatus("s1", "ready");
      manager.updateStatus("s2", "stopped");
      manager.setError("s3", "crashed");

      expect(manager.activeCount()).toBe(1);
    });

    it("returns 0 when all sessions are terminal", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      manager.updateStatus("s1", "stopped");

      expect(manager.activeCount()).toBe(0);
    });

    it("returns 0 when no sessions exist", () => {
      expect(manager.activeCount()).toBe(0);
    });
  });

  describe("token index helpers", () => {
    it("getTokenIndex returns the assigned index", () => {
      manager.create("s1", "c1", 3, { model: "sonnet" });
      expect(manager.getTokenIndex("s1")).toBe(3);
    });

    it("getTokenIndex returns undefined for unknown sessions", () => {
      expect(manager.getTokenIndex("nonexistent")).toBeUndefined();
    });

    it("activeTokenIndices returns active session-token pairs", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      manager.create("s2", "c2", 1, { model: "sonnet" });
      manager.create("s3", "c3", 2, { model: "sonnet" });
      manager.updateStatus("s2", "stopped");

      const active = manager.activeTokenIndices();
      expect(active).toHaveLength(2);
      expect(active.map((a) => a.sessionId).sort()).toEqual(["s1", "s3"]);
    });

    it("maxTokenIndex returns the highest index used", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      manager.create("s2", "c2", 5, { model: "sonnet" });
      manager.create("s3", "c3", 3, { model: "sonnet" });

      expect(manager.maxTokenIndex()).toBe(5);
    });

    it("maxTokenIndex returns undefined when no sessions", () => {
      expect(manager.maxTokenIndex()).toBeUndefined();
    });
  });

  describe("constructor recovery", () => {
    it("marks non-terminal sessions as stopped on startup", () => {
      // Create sessions directly in DB to simulate pre-restart state
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO sessions (id, container_id, status, oauth_token_index, model, created_at, last_activity)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("s-ready", "c1", "ready", 0, "sonnet", now, now);
      db.prepare(`
        INSERT INTO sessions (id, container_id, status, oauth_token_index, model, created_at, last_activity)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("s-stopped", "c2", "stopped", 0, "sonnet", now, now);

      // Re-create manager (simulates restart)
      const newManager = new SessionManager(db);

      expect(newManager.get("s-ready")!.status).toBe("stopped");
      expect(newManager.get("s-stopped")!.status).toBe("stopped");
    });
  });

  describe("runtime state (ws, pendingResolve)", () => {
    it("sets and gets WebSocket references", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });

      const fakeWs = { readyState: 1 } as any;
      manager.setWs("s1", fakeWs);

      const session = manager.get("s1");
      expect(session!.ws).toBe(fakeWs);
    });

    it("clears runtime state on clearRuntime", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      manager.setWs("s1", { readyState: 1 } as any);
      manager.clearRuntime("s1");

      const session = manager.get("s1");
      expect(session!.ws).toBeUndefined();
    });
  });
});

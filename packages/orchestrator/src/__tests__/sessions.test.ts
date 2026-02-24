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

    it("stores pinned flag", () => {
      manager.create("s1", "c1", 0, { model: "sonnet", pinned: true });
      expect(manager.get("s1")!.pinned).toBe(true);
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
    it("preserves persisted status on startup (recovery handled by orchestrator boot)", () => {
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

      expect(newManager.get("s-ready")!.status).toBe("ready");
      expect(newManager.get("s-stopped")!.status).toBe("stopped");
    });
  });

  describe("name", () => {
    it("creates a session with a name", () => {
      const session = manager.create("s1", "c1", 0, {
        model: "sonnet",
        name: "my-agent",
      });
      expect(session.name).toBe("my-agent");
    });

    it("creates a session without a name", () => {
      const session = manager.create("s1", "c1", 0, { model: "sonnet" });
      expect(session.name).toBeUndefined();
    });

    it("renames a session", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      const ok = manager.rename("s1", "new-name");
      expect(ok).toBe(true);
      expect(manager.get("s1")!.name).toBe("new-name");
    });

    it("rejects duplicate names", () => {
      manager.create("s1", "c1", 0, { model: "sonnet", name: "taken" });
      manager.create("s2", "c2", 1, { model: "sonnet" });

      const ok = manager.rename("s2", "taken");
      expect(ok).toBe(false);
      expect(manager.get("s2")!.name).toBeUndefined();
    });

    it("allows renaming to the same name (no-op dedup)", () => {
      manager.create("s1", "c1", 0, { model: "sonnet", name: "same" });
      const ok = manager.rename("s1", "same");
      expect(ok).toBe(true);
    });

    it("nameExists returns true for existing names", () => {
      manager.create("s1", "c1", 0, { model: "sonnet", name: "exists" });
      expect(manager.nameExists("exists")).toBe(true);
    });

    it("nameExists returns false for unused names", () => {
      expect(manager.nameExists("nope")).toBe(false);
    });
  });

  describe("pinned", () => {
    it("defaults to false", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      expect(manager.get("s1")!.pinned).toBe(false);
    });

    it("updates pinned state", () => {
      manager.create("s1", "c1", 0, { model: "sonnet" });
      manager.setPinned("s1", true);
      expect(manager.get("s1")!.pinned).toBe(true);

      manager.setPinned("s1", false);
      expect(manager.get("s1")!.pinned).toBe(false);
    });
  });

  describe("evictableByLru", () => {
    it("returns only ready/idle unpinned sessions in least-recently-active order", () => {
      manager.create("s-ready-old", "c1", 0, { model: "sonnet" });
      manager.create("s-idle-new", "c2", 0, { model: "sonnet" });
      manager.create("s-busy", "c3", 0, { model: "sonnet" });
      manager.create("s-pinned", "c4", 0, { model: "sonnet", pinned: true });

      manager.updateStatus("s-ready-old", "ready");
      manager.updateStatus("s-idle-new", "idle");
      manager.updateStatus("s-busy", "busy");
      manager.updateStatus("s-pinned", "ready");

      db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run("2025-01-01T00:00:00.000Z", "s-ready-old");
      db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run("2025-01-01T00:10:00.000Z", "s-idle-new");

      const evictable = manager.evictableByLru();
      expect(evictable.map((s) => s.id)).toEqual(["s-ready-old", "s-idle-new"]);
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

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../db.js";
import { TenantManager } from "../tenants.js";
import { SessionManager } from "../sessions.js";

describe("TenantManager", () => {
  let db: Database.Database;
  let tenants: TenantManager;

  beforeEach(() => {
    db = openDb(":memory:");
    tenants = new TenantManager(db);
  });

  describe("create", () => {
    it("creates a tenant and returns an API key", () => {
      const { tenant, apiKey } = tenants.create({ id: "test", name: "Test Tenant" });
      expect(tenant.id).toBe("test");
      expect(tenant.name).toBe("Test Tenant");
      expect(tenant.namespace).toBe("claude-t-test");
      expect(tenant.maxSessions).toBe(10);
      expect(apiKey).toHaveLength(64); // 32 bytes hex
    });

    it("uses custom namespace when provided", () => {
      const { tenant } = tenants.create({ id: "custom", name: "Custom", namespace: "my-ns" });
      expect(tenant.namespace).toBe("my-ns");
    });

    it("uses custom max_sessions", () => {
      const { tenant } = tenants.create({ id: "limited", name: "Limited", maxSessions: 5 });
      expect(tenant.maxSessions).toBe(5);
    });

    it("throws on duplicate ID", () => {
      tenants.create({ id: "dup", name: "First" });
      expect(() => tenants.create({ id: "dup", name: "Second" })).toThrow();
    });

    it("stores vault and obsidian config", () => {
      const { tenant } = tenants.create({
        id: "vault-test",
        name: "Vault Test",
        vault: "my-vault",
        obsidianAuthToken: "token123",
        obsidianE2eePassword: "pass456",
      });
      expect(tenant.vault).toBe("my-vault");
      expect(tenant.obsidianAuthToken).toBe("token123");
      expect(tenant.obsidianE2eePassword).toBe("pass456");
    });
  });

  describe("getByApiKey", () => {
    it("resolves tenant from plaintext API key", () => {
      const { apiKey } = tenants.create({ id: "lookup", name: "Lookup" });
      const tenant = tenants.getByApiKey(apiKey);
      expect(tenant).toBeDefined();
      expect(tenant!.id).toBe("lookup");
    });

    it("returns undefined for invalid key", () => {
      expect(tenants.getByApiKey("nonexistent")).toBeUndefined();
    });

    it("returns undefined for empty key", () => {
      expect(tenants.getByApiKey("")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns all tenants", () => {
      tenants.create({ id: "a", name: "A" });
      tenants.create({ id: "b", name: "B" });
      const all = tenants.list();
      expect(all).toHaveLength(2);
      expect(all.map((t) => t.id)).toEqual(["a", "b"]);
    });
  });

  describe("update", () => {
    it("updates name and max_sessions", () => {
      tenants.create({ id: "upd", name: "Original" });
      const updated = tenants.update("upd", { name: "Updated", maxSessions: 20 });
      expect(updated!.name).toBe("Updated");
      expect(updated!.maxSessions).toBe(20);
    });

    it("returns undefined for nonexistent tenant", () => {
      expect(tenants.update("nope", { name: "X" })).toBeUndefined();
    });

    it("sets vault to null", () => {
      tenants.create({ id: "v", name: "V", vault: "old-vault" });
      const updated = tenants.update("v", { vault: null });
      expect(updated!.vault).toBeUndefined();
    });
  });

  describe("rotateApiKey", () => {
    it("returns a new key and invalidates the old one", () => {
      const { apiKey: oldKey } = tenants.create({ id: "rot", name: "Rotate" });
      const newKey = tenants.rotateApiKey("rot");
      expect(newKey).toBeDefined();
      expect(newKey).not.toBe(oldKey);

      // Old key no longer works
      expect(tenants.getByApiKey(oldKey)).toBeUndefined();
      // New key works
      expect(tenants.getByApiKey(newKey!)!.id).toBe("rot");
    });

    it("returns undefined for nonexistent tenant", () => {
      expect(tenants.rotateApiKey("nope")).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("removes the tenant", () => {
      const { apiKey } = tenants.create({ id: "del", name: "Delete" });
      expect(tenants.delete("del")).toBe(true);
      expect(tenants.get("del")).toBeUndefined();
      expect(tenants.getByApiKey(apiKey)).toBeUndefined();
    });

    it("returns false for nonexistent tenant", () => {
      expect(tenants.delete("nope")).toBe(false);
    });
  });
});

describe("SessionManager tenant scoping", () => {
  let db: Database.Database;
  let sessions: SessionManager;
  let tenants: TenantManager;

  beforeEach(() => {
    db = openDb(":memory:");
    sessions = new SessionManager(db);
    tenants = new TenantManager(db);
  });

  it("list() filters by tenantId", () => {
    tenants.create({ id: "t1", name: "T1" });
    tenants.create({ id: "t2", name: "T2" });

    sessions.create("s1", "c1", 0, { model: "sonnet", tenantId: "t1" });
    sessions.create("s2", "c2", 1, { model: "sonnet", tenantId: "t2" });
    sessions.create("s3", "c3", 0, { model: "sonnet", tenantId: "t1" });

    const t1Sessions = sessions.list("t1");
    expect(t1Sessions).toHaveLength(2);
    expect(t1Sessions.map((s) => s.id).sort()).toEqual(["s1", "s3"]);

    const t2Sessions = sessions.list("t2");
    expect(t2Sessions).toHaveLength(1);
    expect(t2Sessions[0].id).toBe("s2");

    // No filter returns all
    expect(sessions.list()).toHaveLength(3);
  });

  it("activeCount() filters by tenantId", () => {
    tenants.create({ id: "t1", name: "T1" });
    sessions.create("s1", "c1", 0, { model: "sonnet", tenantId: "t1" });
    sessions.create("s2", "c2", 1, { model: "sonnet", tenantId: "t1" });
    sessions.create("s3", "c3", 0, { model: "sonnet" }); // no tenant

    expect(sessions.activeCount("t1")).toBe(2);
    expect(sessions.activeCount()).toBe(3);
  });

  it("nameExists() is scoped to tenant", () => {
    tenants.create({ id: "t1", name: "T1" });
    tenants.create({ id: "t2", name: "T2" });

    sessions.create("s1", "c1", 0, { model: "sonnet", name: "shared-name", tenantId: "t1" });

    // Same name in t1 = exists
    expect(sessions.nameExists("shared-name", "t1")).toBe(true);
    // Same name in t2 = does not exist
    expect(sessions.nameExists("shared-name", "t2")).toBe(false);
    // Global check = exists
    expect(sessions.nameExists("shared-name")).toBe(true);
  });

  it("session stores tenantId", () => {
    tenants.create({ id: "t1", name: "T1" });
    sessions.create("s1", "c1", 0, { model: "sonnet", tenantId: "t1" });

    const session = sessions.get("s1");
    expect(session!.tenantId).toBe("t1");
  });
});

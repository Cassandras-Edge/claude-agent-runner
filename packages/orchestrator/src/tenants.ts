import { randomBytes, createHash } from "crypto";
import type Database from "better-sqlite3";
import type { TenantRow } from "./db.js";
import { logger } from "./logger.js";

export interface Tenant {
  id: string;
  name: string;
  namespace: string;
  maxSessions: number;
  email?: string;
  vault?: string;
  gitToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTenantConfig {
  id: string;
  name: string;
  namespace?: string; // defaults to "claude-t-{id}"
  maxSessions?: number;
  email?: string;
  vault?: string;
  gitToken?: string;
}

export interface UpdateTenantConfig {
  name?: string;
  maxSessions?: number;
  email?: string | null;
  vault?: string | null;
  gitToken?: string | null;
}

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    namespace: row.namespace,
    maxSessions: row.max_sessions,
    email: row.email ?? undefined,
    vault: row.vault ?? undefined,
    gitToken: row.git_token ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class TenantManager {
  private db: Database.Database;
  // Cache: apiKeyHash -> tenant (invalidated on update/delete)
  private cache = new Map<string, Tenant>();

  constructor(db: Database.Database) {
    this.db = db;
    this.warmCache();
  }

  private warmCache(): void {
    const rows = this.db.prepare("SELECT * FROM tenants").all() as TenantRow[];
    for (const row of rows) {
      this.cache.set(row.api_key_hash, rowToTenant(row));
    }
    logger.info("orchestrator.tenants", "cache_warmed", { count: rows.length });
  }

  /** Create a tenant and return the plaintext API key (shown once). */
  create(config: CreateTenantConfig): { tenant: Tenant; apiKey: string } {
    const apiKey = randomBytes(32).toString("hex");
    const apiKeyHash = hashApiKey(apiKey);
    const namespace = config.namespace || `claude-t-${config.id}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO tenants (id, name, api_key_hash, namespace, max_sessions, email, vault, git_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.id,
      config.name,
      apiKeyHash,
      namespace,
      config.maxSessions ?? 10,
      config.email ?? null,
      config.vault ?? null,
      config.gitToken ?? null,
      now,
      now,
    );

    const tenant = this.get(config.id)!;
    this.cache.set(apiKeyHash, tenant);

    logger.info("orchestrator.tenants", "created", {
      tenant_id: config.id,
      namespace,
      max_sessions: config.maxSessions ?? 10,
    });

    return { tenant, apiKey };
  }

  get(id: string): Tenant | undefined {
    const row = this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as TenantRow | undefined;
    if (!row) return undefined;
    return rowToTenant(row);
  }

  getByApiKey(apiKey: string): Tenant | undefined {
    const hash = hashApiKey(apiKey);
    // Check cache first
    const cached = this.cache.get(hash);
    if (cached) return cached;
    // Fallback to DB
    const row = this.db.prepare("SELECT * FROM tenants WHERE api_key_hash = ?").get(hash) as TenantRow | undefined;
    if (!row) return undefined;
    const tenant = rowToTenant(row);
    this.cache.set(hash, tenant);
    return tenant;
  }

  list(): Tenant[] {
    const rows = this.db.prepare("SELECT * FROM tenants ORDER BY created_at ASC").all() as TenantRow[];
    return rows.map(rowToTenant);
  }

  update(id: string, config: UpdateTenantConfig): Tenant | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const sets: string[] = [];
    const params: any[] = [];

    if (config.name !== undefined) { sets.push("name = ?"); params.push(config.name); }
    if (config.maxSessions !== undefined) { sets.push("max_sessions = ?"); params.push(config.maxSessions); }
    if (config.email !== undefined) { sets.push("email = ?"); params.push(config.email); }
    if (config.vault !== undefined) { sets.push("vault = ?"); params.push(config.vault); }
    if (config.gitToken !== undefined) { sets.push("git_token = ?"); params.push(config.gitToken); }

    if (sets.length === 0) return existing;

    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);

    this.db.prepare(`UPDATE tenants SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    // Invalidate cache — re-fetch and re-cache
    const updated = this.get(id)!;
    const oldHash = this.db.prepare("SELECT api_key_hash FROM tenants WHERE id = ?").get(id) as { api_key_hash: string };
    this.cache.set(oldHash.api_key_hash, updated);

    logger.info("orchestrator.tenants", "updated", { tenant_id: id, fields: Object.keys(config) });
    return updated;
  }

  /** Rotate the API key for a tenant. Returns the new plaintext key. */
  rotateApiKey(id: string): string | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    // Remove old cache entry
    const oldRow = this.db.prepare("SELECT api_key_hash FROM tenants WHERE id = ?").get(id) as { api_key_hash: string };
    this.cache.delete(oldRow.api_key_hash);

    const newKey = randomBytes(32).toString("hex");
    const newHash = hashApiKey(newKey);

    this.db.prepare("UPDATE tenants SET api_key_hash = ?, updated_at = ? WHERE id = ?")
      .run(newHash, new Date().toISOString(), id);

    const updated = this.get(id)!;
    this.cache.set(newHash, updated);

    logger.info("orchestrator.tenants", "api_key_rotated", { tenant_id: id });
    return newKey;
  }

  delete(id: string): boolean {
    // Remove cache entry
    const row = this.db.prepare("SELECT api_key_hash FROM tenants WHERE id = ?").get(id) as { api_key_hash: string } | undefined;
    if (!row) return false;
    this.cache.delete(row.api_key_hash);

    this.db.prepare("DELETE FROM tenants WHERE id = ?").run(id);
    logger.info("orchestrator.tenants", "deleted", { tenant_id: id });
    return true;
  }
}

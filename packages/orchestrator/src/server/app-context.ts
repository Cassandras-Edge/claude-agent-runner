import type Database from "better-sqlite3";
import type { Context } from "hono";
import type { AuthClient } from "../auth-client.js";
import type { ContainerManager } from "../docker.js";
import type { SessionManager } from "../sessions.js";
import type { TokenPool } from "../token-pool.js";
import type { Tenant, TenantManager } from "../tenants.js";
import type { WsBridge } from "../ws-bridge.js";

export interface AppContext {
  sessions: SessionManager;
  docker: ContainerManager;
  bridge: WsBridge;
  tokenPool: TokenPool | null;
  db: Database.Database;
  env: Record<string, string>;
  runnerImage: string;
  network: string;
  sessionsVolume: string;
  sessionsPath: string;
  wsPort: number;
  orchestratorWsUrl: string;
  messageTimeoutMs: number;
  maxActiveSessions?: number;
  startedAt: Date;
  warmPool?: import("../warm-pool.js").WarmPool;
  tenants?: TenantManager;
  adminApiKey?: string;
  authClient?: AuthClient;
}

export function getTenant(ctx: AppContext, c: Context): Tenant | undefined {
  if (!ctx.tenants) return undefined;
  try {
    return c.get("tenant");
  } catch {
    return undefined;
  }
}

export function checkOwnership(ctx: AppContext, c: Context, session: { tenantId?: string }): boolean {
  const tenant = getTenant(ctx, c);
  if (!tenant) return true;
  return session.tenantId === tenant.id;
}

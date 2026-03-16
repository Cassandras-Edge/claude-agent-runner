import type { Hono } from "hono";
import { logger } from "../../logger.js";
import type { AppContext } from "../app-context.js";
import { getTenant } from "../app-context.js";

const OBSIDIAN_API = "https://api.obsidian.md";
const SUPPORTED_ENCRYPTION_VERSION = 3;

interface ObsidianVault {
  id: string;
  name: string;
  host: string;
  salt: string;
  password?: string;
  encryption_version: number;
}

interface ObsidianVaultListResponse {
  vaults: ObsidianVault[];
  shared: ObsidianVault[];
}

export function registerVaultRoutes(app: Hono, ctx: AppContext): void {
  /**
   * GET /vaults — list available Obsidian Sync vaults for the authenticated tenant.
   * Fetches the tenant's OBSIDIAN_AUTH_TOKEN from ACL, then queries
   * api.obsidian.md/vault/list to get available remote vaults.
   */
  app.get("/vaults", async (c) => {
    // Try per-tenant credentials from ACL first, fall back to global env var
    const tenant = getTenant(ctx, c);
    let authToken: string | undefined;

    if (tenant?.email && ctx.aclClient) {
      const creds = await ctx.aclClient.fetchCredentials(tenant.email, "runner");
      authToken = creds?.OBSIDIAN_AUTH_TOKEN;
    }

    if (!authToken) {
      authToken = process.env.OBSIDIAN_AUTH_TOKEN;
    }

    if (!authToken) {
      return c.json({ error: "Obsidian auth token not configured" }, 400);
    }

    try {
      const res = await fetch(`${OBSIDIAN_API}/vault/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: authToken, supported_encryption_version: SUPPORTED_ENCRYPTION_VERSION }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        logger.error("orchestrator.api", "obsidian_vault_list_failed", {
          status: res.status,
          error: (body as any).error,
        });
        return c.json({ error: (body as any).error || `Obsidian API returned ${res.status}` }, 502);
      }

      const data = await res.json() as ObsidianVaultListResponse;
      const vaults = [...(data.vaults || []), ...(data.shared || [])].map((v) => ({
        id: v.id,
        name: v.name,
      }));

      logger.info("orchestrator.api", "vaults_listed", { tenant: tenant.id, count: vaults.length });
      return c.json({ vaults });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator.api", "vaults_list_failed", { error: message });
      return c.json({ error: "Failed to fetch vaults", detail: message }, 500);
    }
  });
}

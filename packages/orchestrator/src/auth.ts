import type { Context, Next } from "hono";
import type { TenantManager, Tenant } from "./tenants.js";
import { logger } from "./logger.js";

// Augment Hono context with tenant
declare module "hono" {
  interface ContextVariableMap {
    tenant: Tenant;
  }
}

const PUBLIC_PATHS = new Set(["/health"]);

export function createAuthMiddleware(tenants: TenantManager, adminApiKey?: string) {
  return async (c: Context, next: Next) => {
    // Public endpoints — no auth required
    if (PUBLIC_PATHS.has(c.req.path)) {
      return next();
    }

    const apiKey = c.req.header("x-api-key");
    if (!apiKey) {
      logger.debug("orchestrator.auth", "missing_api_key", { path: c.req.path });
      return c.json({ error: "Missing X-API-Key header" }, 401);
    }

    // Admin routes: /tenants/* require admin key
    if (c.req.path.startsWith("/tenants")) {
      if (!adminApiKey) {
        return c.json({ error: "Tenant management not configured" }, 503);
      }
      if (apiKey !== adminApiKey) {
        // Also allow tenant keys for GET /tenants (self-info)
        const tenant = tenants.getByApiKey(apiKey);
        if (!tenant) {
          logger.debug("orchestrator.auth", "invalid_admin_key", { path: c.req.path });
          return c.json({ error: "Unauthorized" }, 401);
        }
        // Non-admin tenant can only access their own tenant info
        c.set("tenant", tenant);
        return next();
      }
      // Admin key — no tenant context, but allow through
      return next();
    }

    // Regular routes: resolve tenant from API key
    const tenant = tenants.getByApiKey(apiKey);
    if (!tenant) {
      logger.debug("orchestrator.auth", "invalid_api_key", { path: c.req.path });
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("tenant", tenant);
    return next();
  };
}

/** Validate API key from WS query param. Returns tenant or undefined. */
export function authenticateWs(tenants: TenantManager, apiKey: string | null): Tenant | undefined {
  if (!apiKey) return undefined;
  return tenants.getByApiKey(apiKey);
}

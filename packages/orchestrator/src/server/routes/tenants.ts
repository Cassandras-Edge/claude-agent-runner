import type { Hono } from "hono";
import type { ErrorResponse } from "../../types.js";
import { getTenant } from "../app-context.js";
import type { AppContext } from "../app-context.js";

export function registerTenantRoutes(app: Hono, ctx: AppContext): void {
  if (!ctx.tenants) {
    return;
  }

  const tenantMgr = ctx.tenants;

  app.get("/tenants", (c) => {
    const tenant = getTenant(ctx, c);
    if (tenant) {
      return c.json({
        tenants: [
          {
            id: tenant.id,
            name: tenant.name,
            namespace: tenant.namespace,
            max_sessions: tenant.maxSessions,
            created_at: tenant.createdAt.toISOString(),
          },
        ],
      });
    }
    const all = tenantMgr.list().map((entry) => ({
      id: entry.id,
      name: entry.name,
      namespace: entry.namespace,
      max_sessions: entry.maxSessions,
      created_at: entry.createdAt.toISOString(),
      updated_at: entry.updatedAt.toISOString(),
    }));
    return c.json({ tenants: all });
  });

  app.get("/tenants/:id", (c) => {
    const tenant = getTenant(ctx, c);
    const id = c.req.param("id");
    if (tenant && tenant.id !== id) {
      return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
    }
    const found = tenantMgr.get(id);
    if (!found) return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
    return c.json({
      id: found.id,
      name: found.name,
      namespace: found.namespace,
      max_sessions: found.maxSessions,
      email: found.email,
      vault: found.vault,
      has_git_token: !!found.gitToken,
      created_at: found.createdAt.toISOString(),
      updated_at: found.updatedAt.toISOString(),
    });
  });

  app.post("/tenants", async (c) => {
    const tenant = getTenant(ctx, c);
    if (tenant) {
      return c.json({ code: "invalid_request", message: "Only admin can create tenants" } satisfies ErrorResponse, 403 as any);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON" } satisfies ErrorResponse, 400 as any);
    }

    if (!body.id || !body.name) {
      return c.json({ code: "invalid_request", message: "Fields id and name are required" } satisfies ErrorResponse, 400 as any);
    }

    try {
      const { tenant: created, apiKey } = tenantMgr.create({
        id: body.id,
        name: body.name,
        namespace: body.namespace,
        maxSessions: body.max_sessions,
        email: body.email,
        vault: body.vault,
        gitToken: body.git_token,
      });

      return c.json(
        {
          id: created.id,
          name: created.name,
          namespace: created.namespace,
          api_key: apiKey,
          max_sessions: created.maxSessions,
        },
        201 as any,
      );
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE constraint")) {
        return c.json({ code: "invalid_request", message: "Tenant ID or namespace already exists" } satisfies ErrorResponse, 409 as any);
      }
      throw err;
    }
  });

  app.patch("/tenants/:id", async (c) => {
    const tenant = getTenant(ctx, c);
    if (tenant) {
      return c.json({ code: "invalid_request", message: "Only admin can update tenants" } satisfies ErrorResponse, 403 as any);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON" } satisfies ErrorResponse, 400 as any);
    }

    const updated = tenantMgr.update(c.req.param("id"), {
      name: body.name,
      maxSessions: body.max_sessions,
      email: body.email,
      vault: body.vault,
      gitToken: body.git_token,
    });

    if (!updated) return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
    return c.json({ id: updated.id, name: updated.name, max_sessions: updated.maxSessions });
  });

  app.post("/tenants/:id/rotate-key", (c) => {
    const tenant = getTenant(ctx, c);
    if (tenant) {
      return c.json({ code: "invalid_request", message: "Only admin can rotate keys" } satisfies ErrorResponse, 403 as any);
    }

    const newKey = tenantMgr.rotateApiKey(c.req.param("id"));
    if (!newKey) return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
    return c.json({ id: c.req.param("id"), api_key: newKey });
  });

  app.delete("/tenants/:id", (c) => {
    const tenant = getTenant(ctx, c);
    if (tenant) {
      return c.json({ code: "invalid_request", message: "Only admin can delete tenants" } satisfies ErrorResponse, 403 as any);
    }

    const deleted = tenantMgr.delete(c.req.param("id"));
    if (!deleted) return c.json({ code: "session_not_found", message: "Tenant not found" } satisfies ErrorResponse, 404 as any);
    return c.json({ deleted: true });
  });
}

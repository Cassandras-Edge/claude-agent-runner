import { randomUUID } from "crypto";
import type { Hono } from "hono";
import { createAuthMiddleware } from "../auth.js";
import { runWithLogContext } from "../logger.js";
import * as metrics from "../metrics.js";
import type { AppContext } from "./app-context.js";

export function registerServerMiddleware(app: Hono, ctx: AppContext): void {
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const traceId = c.req.header("x-trace-id") || requestId;
    c.header("x-request-id", requestId);
    c.header("x-trace-id", traceId);

    return runWithLogContext({ requestId, traceId }, async () => {
      await next();
    });
  });

  if (ctx.tenants) {
    app.use("*", createAuthMiddleware(ctx.tenants, ctx.adminApiKey));
  }

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const duration = (performance.now() - start) / 1000;
    const path = normalizePath(c.req.path);
    metrics.apiRequestsTotal.inc({ method: c.req.method, path, status: String(c.res.status) });
    metrics.apiRequestDurationSeconds.observe({ method: c.req.method, path }, duration);
  });
}

function normalizePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "/:id")
    .replace(/\/snapshots\/\d+/g, "/snapshots/:snapId");
}

import type { Hono } from "hono";
import { logger } from "../../logger.js";
import * as metrics from "../../metrics.js";
import type { AppContext } from "../app-context.js";

export function registerHealthRoutes(app: Hono, ctx: AppContext): void {
  app.get("/health", async (c) => {
    const dockerConnected = await ctx.docker.checkConnection();
    logger.debug("orchestrator.api", "health_check", { docker_connected: dockerConnected });
    return c.json({
      status: "ok",
      active_sessions: ctx.sessions.activeCount(),
      token_pool: {
        size: ctx.tokenPool.size,
        usage: ctx.tokenPool.usage(),
      },
      uptime_ms: Date.now() - ctx.startedAt.getTime(),
      runner_image: ctx.runnerImage,
      docker_connected: dockerConnected,
      max_active_sessions: ctx.maxActiveSessions ?? null,
      warm_pool: ctx.warmPool?.stats ?? null,
    });
  });

  app.get("/metrics", async () => {
    const metricsOutput = await metrics.register.metrics();
    return new Response(metricsOutput, {
      headers: { "Content-Type": metrics.register.contentType },
    });
  });
}

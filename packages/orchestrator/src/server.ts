import { Hono } from "hono";
import type { AppContext } from "./server/app-context.js";
import { registerServerMiddleware } from "./server/middleware.js";
import { registerContextRoutes } from "./server/routes/context.js";
import { registerHealthRoutes } from "./server/routes/health.js";
import { registerSessionRoutes } from "./server/routes/sessions.js";
import { registerTenantRoutes } from "./server/routes/tenants.js";
import { registerUtilityRoutes } from "./server/routes/utility.js";
import { registerVaultRoutes } from "./server/routes/vaults.js";

export { type AppContext } from "./server/app-context.js";

export function createServer(ctx: AppContext): Hono {
  const app = new Hono();

  registerServerMiddleware(app, ctx);
  registerHealthRoutes(app, ctx);
  registerContextRoutes(app, ctx);
  registerUtilityRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerTenantRoutes(app, ctx);
  registerVaultRoutes(app, ctx);

  return app;
}

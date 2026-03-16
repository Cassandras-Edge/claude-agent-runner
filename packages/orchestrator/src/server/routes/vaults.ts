import type { Hono } from "hono";
import { execSync } from "child_process";
import { logger } from "../../logger.js";
import type { AppContext } from "../app-context.js";

export function registerVaultRoutes(app: Hono, _ctx: AppContext): void {
  /**
   * GET /vaults — list available Obsidian Sync vaults.
   * Runs `ob sync-list-remote` and parses the output.
   * Requires OBSIDIAN_AUTH_TOKEN to be set on the orchestrator.
   */
  app.get("/vaults", async (c) => {
    const authToken = process.env.OBSIDIAN_AUTH_TOKEN;
    if (!authToken) {
      return c.json({ error: "OBSIDIAN_AUTH_TOKEN not configured" }, 503);
    }

    try {
      const output = execSync("ob sync-list-remote", {
        timeout: 15_000,
        encoding: "utf-8",
        env: { ...process.env, OBSIDIAN_AUTH_TOKEN: authToken },
      });

      // Parse output format:
      //   02d898f42121b7187c52e07aae5445b2  "Cassandra-Finance"  (North America)
      const vaults: { id: string; name: string; region: string }[] = [];
      for (const line of output.split("\n")) {
        const match = line.match(/^\s*([a-f0-9]+)\s+"([^"]+)"\s+\(([^)]+)\)/);
        if (match) {
          vaults.push({ id: match[1], name: match[2], region: match[3] });
        }
      }

      logger.info("orchestrator.api", "vaults_listed", { count: vaults.length });
      return c.json({ vaults });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("orchestrator.api", "vaults_list_failed", { error: message });
      return c.json({ error: "Failed to list vaults", detail: message }, 500);
    }
  });
}

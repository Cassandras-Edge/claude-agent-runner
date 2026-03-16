import { logger } from "./logger.js";

export interface AuthClientConfig {
  authUrl: string;
  authSecret: string;
}

/**
 * Client for the centralized auth service (cassandra-auth worker).
 * Fetches per-user credentials keyed by email + service.
 */
export class AuthClient {
  private url: string;
  private secret: string;

  constructor(config: AuthClientConfig) {
    this.url = config.authUrl.replace(/\/+$/, "");
    this.secret = config.authSecret;
  }

  /**
   * Fetch credentials for a user+service from the auth credential store.
   * Returns a key-value map (e.g. { OBSIDIAN_AUTH_TOKEN: "...", OBSIDIAN_E2EE_PASSWORD: "..." })
   * or null if no credentials are stored.
   */
  async fetchCredentials(email: string, service: string): Promise<Record<string, string> | null> {
    const endpoint = `${this.url}/credentials/${encodeURIComponent(email)}/${encodeURIComponent(service)}`;

    try {
      const res = await fetch(endpoint, {
        headers: { "X-Auth-Secret": this.secret },
      });

      if (!res.ok) {
        logger.warn("orchestrator.auth_client", "fetch_credentials_failed", {
          email,
          service,
          status: res.status,
        });
        return null;
      }

      const body = await res.json() as { credentials: Record<string, string> | null };
      if (!body.credentials) {
        logger.debug("orchestrator.auth_client", "no_credentials_found", { email, service });
        return null;
      }

      logger.debug("orchestrator.auth_client", "credentials_fetched", {
        email,
        service,
        keys: Object.keys(body.credentials),
      });
      return body.credentials;
    } catch (err) {
      logger.error("orchestrator.auth_client", "fetch_credentials_error", {
        email,
        service,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

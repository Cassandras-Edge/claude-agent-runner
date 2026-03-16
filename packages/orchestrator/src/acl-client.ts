import { logger } from "./logger.js";

export interface AclClientConfig {
  aclUrl: string;
  aclSecret: string;
}

/**
 * Client for the centralized ACL service (cassandra-auth worker).
 * Fetches per-user credentials keyed by email + service.
 */
export class AclClient {
  private url: string;
  private secret: string;

  constructor(config: AclClientConfig) {
    this.url = config.aclUrl.replace(/\/+$/, "");
    this.secret = config.aclSecret;
  }

  /**
   * Fetch credentials for a user+service from the ACL credential store.
   * Returns a key-value map (e.g. { OBSIDIAN_AUTH_TOKEN: "...", OBSIDIAN_E2EE_PASSWORD: "..." })
   * or null if no credentials are stored.
   */
  async fetchCredentials(email: string, service: string): Promise<Record<string, string> | null> {
    const endpoint = `${this.url}/credentials/${encodeURIComponent(email)}/${encodeURIComponent(service)}`;

    try {
      const res = await fetch(endpoint, {
        headers: { "X-ACL-Secret": this.secret },
      });

      if (!res.ok) {
        logger.warn("orchestrator.acl_client", "fetch_credentials_failed", {
          email,
          service,
          status: res.status,
        });
        return null;
      }

      const body = await res.json() as { credentials: Record<string, string> | null };
      if (!body.credentials) {
        logger.debug("orchestrator.acl_client", "no_credentials_found", { email, service });
        return null;
      }

      logger.debug("orchestrator.acl_client", "credentials_fetched", {
        email,
        service,
        keys: Object.keys(body.credentials),
      });
      return body.credentials;
    } catch (err) {
      logger.error("orchestrator.acl_client", "fetch_credentials_error", {
        email,
        service,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

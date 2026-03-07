import { randomUUID } from "crypto";
import type { ContainerManager } from "./docker.js";
import type { WsBridge } from "./ws-bridge.js";
import type { TokenPool } from "./token-pool.js";
import { logger } from "./logger.js";

export interface WarmEntry {
  warmId: string;
  containerId: string;
  tokenIndex: number;
  status: "spawning" | "ready";
  spawnedAt: Date;
  vault?: string;
  agentId?: string;
}

export interface WarmPoolProfile {
  vault?: string;
  agentId?: string;
  namespace?: string;
  targetSize: number;
}

export interface WarmPoolConfig {
  profiles: WarmPoolProfile[];
  docker: ContainerManager;
  bridge: WsBridge;
  tokenPool: TokenPool;
  runnerImage: string;
  orchestratorWsUrl: string;
  network: string;
  sessionsVolume: string;
  env: Record<string, string>;
}

export class WarmPool {
  private pool: WarmEntry[] = [];
  private refilling = false;
  private config: WarmPoolConfig;

  constructor(config: WarmPoolConfig) {
    this.config = config;
    logger.info("orchestrator.warm_pool", "initialized", {
      profiles: config.profiles.map((p) => ({
        vault: p.vault ?? "none",
        agentId: p.agentId ?? "none",
        target: p.targetSize,
      })),
      total_target: this.targetSize,
    });
  }

  /** Take a warm entry matching vault + agentId for a session. */
  adopt(vault?: string, agentId?: string): WarmEntry | null {
    const idx = this.findReady((e) =>
      (vault ? e.vault === vault : !e.vault) &&
      (agentId ? e.agentId === agentId : !e.agentId),
    );
    if (idx === -1) return null;

    const entry = this.pool.splice(idx, 1)[0];
    logger.info("orchestrator.warm_pool", "adopted", {
      warm_id: entry.warmId,
      vault: entry.vault ?? "none",
      agent_id: entry.agentId ?? "none",
      pool_remaining: this.pool.length,
    });

    this.refill().catch((err) => {
      logger.error("orchestrator.warm_pool", "refill_after_adopt_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return entry;
  }

  /** Take a generic warm entry for ephemeral one-shot use. Caller kills it when done. */
  take(): WarmEntry | null {
    const idx = this.findReady((e) => !e.vault && !e.agentId);
    if (idx === -1) return null;

    const entry = this.pool.splice(idx, 1)[0];
    logger.info("orchestrator.warm_pool", "taken", {
      warm_id: entry.warmId,
      pool_remaining: this.pool.length,
    });

    this.refill().catch((err) => {
      logger.error("orchestrator.warm_pool", "refill_after_take_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return entry;
  }

  markReady(warmId: string): void {
    const entry = this.pool.find((e) => e.warmId === warmId);
    if (entry) {
      entry.status = "ready";
      logger.info("orchestrator.warm_pool", "entry_ready", {
        warm_id: warmId,
        vault: entry.vault ?? "none",
        agent_id: entry.agentId ?? "none",
        pool_ready: this.readyCount,
        pool_total: this.pool.length,
      });
    }
  }

  async refill(): Promise<void> {
    if (this.refilling) return;
    this.refilling = true;

    try {
      const promises: Promise<void>[] = [];

      for (const profile of this.config.profiles) {
        const current = this.pool.filter((e) => this.matchesProfile(e, profile)).length;
        const needed = profile.targetSize - current;

        if (needed > 0) {
          logger.info("orchestrator.warm_pool", "refilling_profile", {
            vault: profile.vault ?? "none",
            agent_id: profile.agentId ?? "none",
            needed,
            current,
            target: profile.targetSize,
          });
          for (let i = 0; i < needed; i++) {
            promises.push(this.spawnWarmContainer(profile));
          }
        }
      }

      if (promises.length > 0) {
        await Promise.allSettled(promises);
      }
    } finally {
      this.refilling = false;
    }
  }

  private async spawnWarmContainer(profile: WarmPoolProfile): Promise<void> {
    const warmId = `warm-${randomUUID()}`;
    const { token, tokenIndex } = this.config.tokenPool.assign(warmId);

    const entry: WarmEntry = {
      warmId,
      containerId: "",
      tokenIndex,
      status: "spawning",
      spawnedAt: new Date(),
      vault: profile.vault,
      agentId: profile.agentId,
    };
    this.pool.push(entry);

    try {
      const containerId = await this.config.docker.spawn({
        sessionId: warmId,
        image: this.config.runnerImage,
        orchestratorUrl: this.config.orchestratorWsUrl,
        env: { ...this.config.env, CLAUDE_CODE_OAUTH_TOKEN: token },
        network: this.config.network,
        sessionsVolume: this.config.sessionsVolume,
        vault: profile.vault,
        agentId: profile.agentId,
        namespace: profile.namespace,
      });
      entry.containerId = containerId;

      logger.info("orchestrator.warm_pool", "container_spawned", {
        warm_id: warmId,
        container_id: containerId,
        vault: profile.vault ?? "none",
        agent_id: profile.agentId ?? "none",
      });
    } catch (err) {
      const idx = this.pool.indexOf(entry);
      if (idx !== -1) this.pool.splice(idx, 1);
      this.config.tokenPool.release(warmId);

      logger.error("orchestrator.warm_pool", "spawn_failed", {
        warm_id: warmId,
        vault: profile.vault ?? "none",
        agent_id: profile.agentId ?? "none",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async destroy(): Promise<void> {
    logger.info("orchestrator.warm_pool", "destroying", { count: this.pool.length });

    const promises = this.pool.map(async (entry) => {
      try {
        await this.config.docker.kill(entry.warmId);
      } catch {
        // Best effort
      }
      this.config.tokenPool.release(entry.warmId);
    });

    await Promise.allSettled(promises);
    this.pool = [];
  }

  isWarmId(id: string): boolean {
    return this.pool.some((e) => e.warmId === id);
  }

  get size(): number {
    return this.pool.length;
  }

  get readyCount(): number {
    return this.pool.filter((e) => e.status === "ready").length;
  }

  get targetSize(): number {
    return this.config.profiles.reduce((sum, p) => sum + p.targetSize, 0);
  }

  get stats(): {
    target: number;
    total: number;
    ready: number;
    spawning: number;
    profiles: Array<{ vault: string; agentId: string; target: number; current: number; ready: number }>;
  } {
    const profiles = this.config.profiles.map((p) => {
      const entries = this.pool.filter((e) => this.matchesProfile(e, p));
      return {
        vault: p.vault ?? "none",
        agentId: p.agentId ?? "none",
        target: p.targetSize,
        current: entries.length,
        ready: entries.filter((e) => e.status === "ready").length,
      };
    });

    return {
      target: this.targetSize,
      total: this.pool.length,
      ready: this.readyCount,
      spawning: this.pool.filter((e) => e.status === "spawning").length,
      profiles,
    };
  }

  private findReady(predicate: (e: WarmEntry) => boolean): number {
    return this.pool.findIndex(
      (e) => e.status === "ready" && this.config.bridge.isConnected(e.warmId) && predicate(e),
    );
  }

  private matchesProfile(entry: WarmEntry, profile: WarmPoolProfile): boolean {
    return (
      (profile.vault ? entry.vault === profile.vault : !entry.vault) &&
      (profile.agentId ? entry.agentId === profile.agentId : !entry.agentId)
    );
  }
}

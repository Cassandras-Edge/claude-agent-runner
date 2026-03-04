import { randomUUID } from "crypto";
import type { DockerManager } from "./docker.js";
import type { WsBridge } from "./ws-bridge.js";
import type { TokenPool } from "./token-pool.js";
import { logger } from "./logger.js";

export interface WarmEntry {
  warmId: string;
  containerId: string;
  tokenIndex: number;
  status: "spawning" | "ready";
  spawnedAt: Date;
}

export interface WarmPoolConfig {
  targetSize: number;
  docker: DockerManager;
  bridge: WsBridge;
  tokenPool: TokenPool;
  runnerImage: string;
  orchestratorWsUrl: string;
  network: string;
  sessionsVolume: string;
  vaultsVolume: string;
  env: Record<string, string>;
}

export class WarmPool {
  private pool: WarmEntry[] = [];
  private refilling = false;
  private config: WarmPoolConfig;

  constructor(config: WarmPoolConfig) {
    this.config = config;
    logger.info("orchestrator.warm_pool", "initialized", { target_size: config.targetSize });
  }

  /** Take a ready warm entry from the pool. Returns null if none available. */
  adopt(): WarmEntry | null {
    const idx = this.pool.findIndex(
      (e) => e.status === "ready" && this.config.bridge.isConnected(e.warmId),
    );
    if (idx === -1) return null;

    const entry = this.pool.splice(idx, 1)[0];
    logger.info("orchestrator.warm_pool", "adopted", {
      warm_id: entry.warmId,
      pool_remaining: this.pool.length,
    });

    // Trigger async replenishment
    this.refill().catch((err) => {
      logger.error("orchestrator.warm_pool", "refill_after_adopt_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return entry;
  }

  /** Mark a warm container as ready (called when it sends status=ready via WS). */
  markReady(warmId: string): void {
    const entry = this.pool.find((e) => e.warmId === warmId);
    if (entry) {
      entry.status = "ready";
      logger.info("orchestrator.warm_pool", "entry_ready", {
        warm_id: warmId,
        pool_ready: this.readyCount,
        pool_total: this.pool.length,
      });
    }
  }

  /** Spawn containers to fill pool up to target size. */
  async refill(): Promise<void> {
    if (this.refilling) return;
    this.refilling = true;

    try {
      const needed = this.config.targetSize - this.pool.length;
      if (needed <= 0) return;

      logger.info("orchestrator.warm_pool", "refilling", {
        needed,
        current: this.pool.length,
        target: this.config.targetSize,
      });

      const promises: Promise<void>[] = [];
      for (let i = 0; i < needed; i++) {
        promises.push(this.spawnWarmContainer());
      }
      await Promise.allSettled(promises);
    } finally {
      this.refilling = false;
    }
  }

  private async spawnWarmContainer(): Promise<void> {
    const warmId = `warm-${randomUUID()}`;
    const { token, tokenIndex } = this.config.tokenPool.assign(warmId);

    const entry: WarmEntry = {
      warmId,
      containerId: "",
      tokenIndex,
      status: "spawning",
      spawnedAt: new Date(),
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
        vaultsVolume: this.config.vaultsVolume,
        // No repo, workspace, or additionalDirectories for warm containers
      });
      entry.containerId = containerId;

      logger.info("orchestrator.warm_pool", "container_spawned", {
        warm_id: warmId,
        container_id: containerId,
      });
    } catch (err) {
      // Remove failed entry from pool and release token
      const idx = this.pool.indexOf(entry);
      if (idx !== -1) this.pool.splice(idx, 1);
      this.config.tokenPool.release(warmId);

      logger.error("orchestrator.warm_pool", "spawn_failed", {
        warm_id: warmId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Kill all warm containers and release their tokens. */
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

  /** Check if a session ID belongs to the warm pool. */
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
    return this.config.targetSize;
  }

  get stats(): { target: number; total: number; ready: number; spawning: number } {
    return {
      target: this.config.targetSize,
      total: this.pool.length,
      ready: this.readyCount,
      spawning: this.pool.filter((e) => e.status === "spawning").length,
    };
  }
}

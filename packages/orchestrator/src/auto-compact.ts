import type { WsBridge } from "./ws-bridge.js";
import type { SessionManager } from "./sessions.js";
import { logger } from "./logger.js";

export interface AutoCompactConfig {
  thresholdPct: number;
  idleSeconds: number;
  highContextModelCap: number;
}

const DEFAULT_CONFIG: AutoCompactConfig = {
  thresholdPct: parseInt(process.env.AUTO_COMPACT_THRESHOLD_PCT || "95", 10),
  idleSeconds: parseInt(process.env.AUTO_COMPACT_IDLE_SECONDS || "30", 10),
  highContextModelCap: 60,
};

/**
 * Watches session context usage and triggers compaction when a session
 * is idle and context exceeds the threshold.
 */
export class AutoCompactor {
  private config: AutoCompactConfig;
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // session_id → context percentage (0–100)
  private contextPct = new Map<string, number>();

  constructor(
    private bridge: WsBridge,
    private sessions: SessionManager,
    config?: Partial<AutoCompactConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info("orchestrator.auto_compact", "initialized", {
      threshold_pct: this.config.thresholdPct,
      idle_seconds: this.config.idleSeconds,
    });
  }

  /**
   * Call when a context_state event is received for a session.
   * contextTokens is the raw context window usage (not a percentage).
   */
  onContextState(sessionId: string, contextTokens: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Estimate context percentage from model's context window
    const modelName = (session as any).model || "sonnet";
    const contextWindow = this.getContextWindow(modelName);
    const pct = contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 100) : 0;
    this.contextPct.set(sessionId, pct);
  }

  /**
   * Call when a session transitions to idle/ready status.
   */
  onStatusChange(sessionId: string, status: string): void {
    if (status === "idle" || status === "ready") {
      this.startIdleTimer(sessionId);
    } else {
      this.cancelIdleTimer(sessionId);
    }
  }

  /**
   * Clean up when a session is removed.
   */
  onSessionRemoved(sessionId: string): void {
    this.cancelIdleTimer(sessionId);
    this.contextPct.delete(sessionId);
  }

  private startIdleTimer(sessionId: string): void {
    this.cancelIdleTimer(sessionId);

    const pct = this.contextPct.get(sessionId) ?? 0;
    if (pct < this.config.thresholdPct) return;

    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      this.maybeCompact(sessionId);
    }, this.config.idleSeconds * 1000);

    this.idleTimers.set(sessionId, timer);
  }

  private cancelIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }

  private maybeCompact(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Only compact if still idle
    if (session.status !== "idle" && session.status !== "ready") return;

    const pct = this.contextPct.get(sessionId) ?? 0;
    if (pct < this.config.thresholdPct) return;

    logger.info("orchestrator.auto_compact", "triggering_compaction", {
      session_id: sessionId,
      context_pct: pct,
      threshold_pct: this.config.thresholdPct,
    });

    this.bridge.sendCompact(sessionId);
    // Reset so we don't compact again immediately
    this.contextPct.delete(sessionId);
  }

  private getContextWindow(model: string): number {
    if (model.includes("[1m]") || model.includes("1m")) return 1_000_000;
    if (model.includes("opus")) return 200_000;
    if (model.includes("sonnet")) return 200_000;
    if (model.includes("haiku")) return 200_000;
    return 200_000;
  }

  destroy(): void {
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    this.contextPct.clear();
  }
}

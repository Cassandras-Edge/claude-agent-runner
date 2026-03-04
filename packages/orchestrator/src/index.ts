import "dotenv/config";
import { mkdirSync } from "fs";
import { serve } from "@hono/node-server";
import { createServer } from "./server.js";
import { SessionManager } from "./sessions.js";
import { DockerManager } from "./docker.js";
import type { ContainerManager } from "./docker.js";
import { K8sManager } from "./k8s-manager.js";
import { WsBridge } from "./ws-bridge.js";
import { TokenPool } from "./token-pool.js";
import { openDb } from "./db.js";
import { attachClientWs } from "./client-ws.js";
import { AutoCompactor } from "./auto-compact.js";
import { WarmPool } from "./warm-pool.js";
import { TenantManager } from "./tenants.js";
import { logger } from "./logger.js";

// --- Config ---

const PORT = parseInt(process.env.PORT || "8080", 10);
const WS_PORT = parseInt(process.env.WS_PORT || "8081", 10);
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || "claude-runner:latest";
const NETWORK = process.env.DOCKER_NETWORK || "claude-net";
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "300000", 10);
const MESSAGE_TIMEOUT_MS = parseInt(process.env.MESSAGE_TIMEOUT_MS || "600000", 10);
const CLEANUP_RUNNERS_ON_EXIT = process.env.CLEANUP_RUNNERS_ON_EXIT === "true";
const rawMaxActiveSessions = parseInt(process.env.MAX_ACTIVE_SESSIONS || "0", 10);
const MAX_ACTIVE_SESSIONS = Number.isFinite(rawMaxActiveSessions) && rawMaxActiveSessions > 0
  ? rawMaxActiveSessions
  : undefined;
const ORCHESTRATOR_HOST = process.env.ORCHESTRATOR_HOST || "host.docker.internal";
const ORCHESTRATOR_WS_URL = `ws://${ORCHESTRATOR_HOST}:${WS_PORT}`;
const DB_PATH = process.env.DB_PATH || "/app/data/orchestrator.db";
const SESSIONS_VOLUME = process.env.SESSIONS_VOLUME || "claude-sessions";
// Where the sessions volume is mounted on the orchestrator (read-only, for transcript API)
const SESSIONS_PATH = process.env.SESSIONS_PATH || "/data/sessions";

const WARM_POOL_SIZE = parseInt(process.env.WARM_POOL_SIZE || "0", 10);
const RUNNER_BACKEND = (process.env.RUNNER_BACKEND || "docker") as "docker" | "k8s";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const ENABLE_TENANTS = process.env.ENABLE_TENANTS === "true";

// --- Token pool ---
const oauthTokens = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!oauthTokens) {
  logger.error("orchestrator.config", "CLAUDE_CODE_OAUTH_TOKEN is required");
  process.exit(1);
}
const tokenPool = new TokenPool(oauthTokens);

logger.info("orchestrator.config", "oauth token pool initialized", {
  token_count: tokenPool.size,
  requested_host: ORCHESTRATOR_HOST,
  ws_port: WS_PORT,
  host_port: PORT,
});

// Base env forwarded to runners (token is added per-session by the server)
const runnerEnv: Record<string, string> = {};
if (process.env.GIT_TOKEN) runnerEnv.GIT_TOKEN = process.env.GIT_TOKEN;
if (process.env.GITHUB_TOKEN) runnerEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Vault sync env vars (optional — required only when using vault source type)
if (process.env.OBSIDIAN_AUTH_TOKEN) runnerEnv.OBSIDIAN_AUTH_TOKEN = process.env.OBSIDIAN_AUTH_TOKEN;
if (process.env.OBSIDIAN_E2EE_PASSWORD) runnerEnv.OBSIDIAN_E2EE_PASSWORD = process.env.OBSIDIAN_E2EE_PASSWORD;

// --- Database ---

// Ensure the data directory exists
mkdirSync(DB_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
const db = openDb(DB_PATH);
logger.info("orchestrator.storage", "opened sqlite database", { path: DB_PATH });

// --- Initialize ---

const sessions = new SessionManager(db);
const tenants = ENABLE_TENANTS ? new TenantManager(db) : undefined;
const docker: ContainerManager = RUNNER_BACKEND === "k8s"
  ? new K8sManager({
      sessionsPvcName: SESSIONS_VOLUME,
      cpuRequest: process.env.RUNNER_CPU_REQUEST,
      cpuLimit: process.env.RUNNER_CPU_LIMIT,
      memoryRequest: process.env.RUNNER_MEMORY_REQUEST,
      memoryLimit: process.env.RUNNER_MEMORY_LIMIT,
    })
  : new DockerManager();
const bridge = new WsBridge(sessions, WS_PORT);
bridge.setDb(db);
const autoCompactor = new AutoCompactor(bridge, sessions);
bridge.on("context_state", (sessionId: string, contextTokens: number) => {
  autoCompactor.onContextState(sessionId, contextTokens);
});
bridge.on("status", (sessionId: string, status: string) => {
  autoCompactor.onStatusChange(sessionId, status);
});
// --- Warm pool (optional) ---
let warmPool: WarmPool | undefined;
if (WARM_POOL_SIZE > 0) {
  warmPool = new WarmPool({
    targetSize: WARM_POOL_SIZE,
    docker,
    bridge,
    tokenPool,
    runnerImage: RUNNER_IMAGE,
    orchestratorWsUrl: ORCHESTRATOR_WS_URL,
    network: NETWORK,
    sessionsVolume: SESSIONS_VOLUME,
    env: runnerEnv,
  });

  // Track warm container readiness from bridge status events
  bridge.on("status", (sessionId: string, status: string) => {
    if (status === "ready" && warmPool?.isWarmId(sessionId)) {
      warmPool.markReady(sessionId);
    }
  });
}

logger.info("orchestrator.bootstrap", "session manager, container manager, ws bridge, and auto-compactor initialized", {
  backend: RUNNER_BACKEND,
  warm_pool_size: WARM_POOL_SIZE,
});

// Reconcile persisted sessions against live Docker state on startup.
const persistedSessions = sessions.list();
const recovered = await docker.recoverFromSessions(persistedSessions);

for (const sessionId of [...recovered.notRunning, ...recovered.missing]) {
  const session = sessions.get(sessionId);
  if (session && session.status !== "stopped" && session.status !== "error") {
    logger.debug("orchestrator.bootstrap", "marking_session_stopped_after_recovery", {
      session_id: sessionId,
      current_status: session.status,
    });
    sessions.updateStatus(sessionId, "stopped");
  }
}
for (const sessionId of recovered.running) {
  const session = sessions.get(sessionId);
  if (session && (session.status === "stopped" || session.status === "error")) {
    // A live runner exists, so restore the session to a resumable non-terminal state.
    logger.debug("orchestrator.bootstrap", "restoring_running_session_to_idle", {
      session_id: sessionId,
      current_status: session.status,
    });
    sessions.updateStatus(sessionId, "idle");
  }
}

// Restore token pool state from reconciled persisted sessions.
tokenPool.restore(sessions.activeTokenIndices(), sessions.maxTokenIndex());
logger.info("orchestrator.bootstrap", "token pool state restored", {
  active_sessions: sessions.activeTokenIndices().length,
  max_token_index: sessions.maxTokenIndex(),
});

// Ensure Docker network exists
await docker.ensureNetwork(NETWORK);

const app = createServer({
  sessions,
  docker,
  bridge,
  tokenPool,
  db,
  env: runnerEnv,
  runnerImage: RUNNER_IMAGE,
  network: NETWORK,
  sessionsVolume: SESSIONS_VOLUME,
  sessionsPath: SESSIONS_PATH,
  wsPort: WS_PORT,
  orchestratorWsUrl: ORCHESTRATOR_WS_URL,
  messageTimeoutMs: MESSAGE_TIMEOUT_MS,
  maxActiveSessions: MAX_ACTIVE_SESSIONS,
  startedAt: new Date(),
  warmPool,
  tenants,
  adminApiKey: ADMIN_API_KEY,
});

// Fill warm pool after network is ready
if (warmPool) {
  warmPool.refill().catch((err) => {
    logger.error("orchestrator.bootstrap", "warm_pool_initial_fill_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// --- Idle timeout sweep ---

const idleSweep = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.list()) {
    if (!session.pinned && (session.status === "ready" || session.status === "idle")) {
      const idle = now - session.lastActivity.getTime();
      if (idle > IDLE_TIMEOUT_MS) {
        logger.warn("orchestrator.idle", "stopping_idle_session", {
          session_id: session.id,
          idle_seconds: Math.round(idle / 1000),
          limit_seconds: IDLE_TIMEOUT_MS / 1000,
        });
        bridge.sendShutdown(session.id);
        docker.kill(session.id);
        sessions.updateStatus(session.id, "stopped");
        tokenPool.release(session.id);
      }
    }
  }
}, 30_000);

// --- Graceful shutdown ---

async function shutdown() {
  logger.info("orchestrator.shutdown", "shutting_down");
  clearInterval(idleSweep);
  autoCompactor.destroy();
  if (warmPool) {
    await warmPool.destroy();
  }
  clientWss.close();
  bridge.close();
  if (CLEANUP_RUNNERS_ON_EXIT) {
    logger.info("orchestrator.shutdown", "cleanup_runners_enabled");
    await docker.cleanup();
  } else {
    logger.info("orchestrator.shutdown", "preserving_runner_containers", {
      cleanup_runners_on_exit: false,
    });
  }
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Start ---

const httpServer = serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info("orchestrator.server", "listening", {
    port: info.port,
    ws_port: WS_PORT,
    runner_backend: RUNNER_BACKEND,
    runner_image: RUNNER_IMAGE,
    docker_network: RUNNER_BACKEND === "docker" ? NETWORK : undefined,
    runner_ws_url: ORCHESTRATOR_WS_URL,
    idle_timeout_seconds: IDLE_TIMEOUT_MS / 1000,
    message_timeout_seconds: MESSAGE_TIMEOUT_MS / 1000,
    max_active_sessions: MAX_ACTIVE_SESSIONS ?? "unlimited",
    token_pool_size: tokenPool.size,
    db_path: DB_PATH,
    sessions_volume: SESSIONS_VOLUME,
    recovered_running: recovered.running.length,
    recovered_not_running: recovered.notRunning.length,
    recovered_missing: recovered.missing.length,
    cleanup_runners_on_exit: CLEANUP_RUNNERS_ON_EXIT,
  });
});

// Attach client-facing WebSocket on /ws path (same HTTP port)
const clientWss = attachClientWs(httpServer, { bridge, sessions });

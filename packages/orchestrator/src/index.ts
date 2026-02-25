import "dotenv/config";
import { mkdirSync } from "fs";
import { serve } from "@hono/node-server";
import { createServer } from "./server.js";
import { SessionManager } from "./sessions.js";
import { DockerManager } from "./docker.js";
import { WsBridge } from "./ws-bridge.js";
import { TokenPool } from "./token-pool.js";
import { openDb } from "./db.js";
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

// --- Database ---

// Ensure the data directory exists
mkdirSync(DB_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
const db = openDb(DB_PATH);
logger.info("orchestrator.storage", "opened sqlite database", { path: DB_PATH });

// --- Initialize ---

const sessions = new SessionManager(db);
const docker = new DockerManager();
const bridge = new WsBridge(sessions, WS_PORT);
bridge.setDb(db);
logger.info("orchestrator.bootstrap", "session manager, docker manager, and ws bridge initialized");

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
});

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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info("orchestrator.server", "listening", {
    port: info.port,
    ws_port: WS_PORT,
    runner_image: RUNNER_IMAGE,
    docker_network: NETWORK,
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

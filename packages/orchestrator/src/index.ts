import "dotenv/config";
import { serve } from "@hono/node-server";
import { createServer } from "./server.js";
import { SessionManager } from "./sessions.js";
import { DockerManager } from "./docker.js";
import { WsBridge } from "./ws-bridge.js";
import { TokenPool } from "./token-pool.js";

// --- Config ---

const PORT = parseInt(process.env.PORT || "8080", 10);
const WS_PORT = parseInt(process.env.WS_PORT || "8081", 10);
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || "claude-runner:latest";
const NETWORK = process.env.DOCKER_NETWORK || "claude-net";
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "300000", 10);
// When orchestrator runs on host (not in Docker), runners need host.docker.internal to reach back
const ORCHESTRATOR_HOST = process.env.ORCHESTRATOR_HOST || "host.docker.internal";
const ORCHESTRATOR_WS_URL = `ws://${ORCHESTRATOR_HOST}:${WS_PORT}`;

// --- Token pool ---
// Supports multiple OAuth tokens (comma-separated). Each session gets pinned to one token.
const oauthTokens = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!oauthTokens) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN is required");
  process.exit(1);
}
const tokenPool = new TokenPool(oauthTokens);

// Base env forwarded to runners (token is added per-session by the server)
const runnerEnv: Record<string, string> = {};
if (process.env.GIT_TOKEN) runnerEnv.GIT_TOKEN = process.env.GIT_TOKEN;
if (process.env.GITHUB_TOKEN) runnerEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// --- Initialize ---

const sessions = new SessionManager();
const docker = new DockerManager();
const bridge = new WsBridge(sessions, WS_PORT);

// Ensure Docker network exists
await docker.ensureNetwork(NETWORK);

const app = createServer({
  sessions,
  docker,
  bridge,
  tokenPool,
  env: runnerEnv,
  runnerImage: RUNNER_IMAGE,
  network: NETWORK,
  wsPort: WS_PORT,
  orchestratorWsUrl: ORCHESTRATOR_WS_URL,
  startedAt: new Date(),
});

// --- Idle timeout sweep ---

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.list()) {
    if (session.status === "ready" || session.status === "idle") {
      const idle = now - session.lastActivity.getTime();
      if (idle > IDLE_TIMEOUT_MS) {
        console.log(`Session ${session.id} idle for ${Math.round(idle / 1000)}s — stopping`);
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
  console.log("Shutting down...");
  bridge.close();
  await docker.cleanup();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Start ---

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`claude-orchestrator listening on :${info.port}`);
  console.log(`WS bridge on :${WS_PORT}`);
  console.log(`Runner image: ${RUNNER_IMAGE}`);
  console.log(`Docker network: ${NETWORK}`);
  console.log(`Runner WS URL: ${ORCHESTRATOR_WS_URL}`);
  console.log(`Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
  console.log(`OAuth token pool: ${tokenPool.size} token(s)`);
});

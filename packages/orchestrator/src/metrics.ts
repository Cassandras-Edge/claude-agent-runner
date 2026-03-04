import client from "prom-client";

export const register = client.register;

// Collect default Node.js metrics (GC, event loop, memory)
client.collectDefaultMetrics({ register });

// --- Sessions ---

export const sessionsCreatedTotal = new client.Counter({
  name: "sessions_created_total",
  help: "Total sessions created",
  labelNames: ["model", "source_type", "tenant_id"] as const,
});

export const sessionsActive = new client.Gauge({
  name: "sessions_active",
  help: "Currently active sessions by status",
  labelNames: ["status", "tenant_id"] as const,
});

export const sessionsDurationSeconds = new client.Histogram({
  name: "sessions_duration_seconds",
  help: "Session lifetime from create to stop/delete",
  labelNames: ["model", "source_type"] as const,
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
});

// --- Messages ---

export const messagesTotal = new client.Counter({
  name: "messages_total",
  help: "Total messages sent to sessions",
  labelNames: ["model", "tenant_id"] as const,
});

export const messageDurationSeconds = new client.Histogram({
  name: "message_duration_seconds",
  help: "Time from message send to result",
  labelNames: ["model"] as const,
  buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300],
});

// --- Tokens & Cost ---

export const tokensConsumedTotal = new client.Counter({
  name: "tokens_consumed_total",
  help: "Total tokens consumed",
  labelNames: ["type", "model", "tenant_id"] as const,
});

export const costUsdTotal = new client.Counter({
  name: "cost_usd_total",
  help: "Total cost in USD",
  labelNames: ["model", "tenant_id"] as const,
});

// --- Spawn ---

export const spawnDurationSeconds = new client.Histogram({
  name: "spawn_duration_seconds",
  help: "Time to spawn a runner (container/pod creation to ready)",
  labelNames: ["backend", "source_type"] as const,
  buckets: [1, 2, 5, 10, 15, 20, 30, 60],
});

// --- Warm Pool ---

export const warmPoolSize = new client.Gauge({
  name: "warm_pool_size",
  help: "Warm pool entries by status",
  labelNames: ["status"] as const,
});

export const warmPoolHitsTotal = new client.Counter({
  name: "warm_pool_hits_total",
  help: "Sessions adopted from warm pool",
});

export const warmPoolMissesTotal = new client.Counter({
  name: "warm_pool_misses_total",
  help: "Sessions that required cold spawn (no warm pool entry available)",
});

// --- Compaction ---

export const compactionsTotal = new client.Counter({
  name: "compactions_total",
  help: "Total context compactions",
  labelNames: ["trigger"] as const,
});

// --- WebSocket ---

export const wsConnectionsActive = new client.Gauge({
  name: "ws_connections_active",
  help: "Active client WebSocket connections",
});

// --- API ---

export const apiRequestsTotal = new client.Counter({
  name: "api_requests_total",
  help: "Total HTTP API requests",
  labelNames: ["method", "path", "status"] as const,
});

export const apiRequestDurationSeconds = new client.Histogram({
  name: "api_request_duration_seconds",
  help: "HTTP API request duration",
  labelNames: ["method", "path"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120],
});

// --- Errors ---

export const runnerErrorsTotal = new client.Counter({
  name: "runner_errors_total",
  help: "Errors reported by runners",
  labelNames: ["error_code"] as const,
});

// --- Token Pool ---

export const tokenPoolUsage = new client.Gauge({
  name: "token_pool_usage",
  help: "Active sessions per token index",
  labelNames: ["token_index"] as const,
});

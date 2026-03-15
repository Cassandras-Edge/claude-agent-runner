# Claude Agent Runner

> **Disclaimer:** This project is experimental and under active development. It wraps the Claude Agent SDK in ways that may break with new Claude Code releases. The CLI patching system is inherently fragile. Use at your own risk — no stability guarantees.

Multi-session Claude Code agent orchestrator. Run concurrent, isolated Claude agent sessions through a REST + WebSocket API with streaming events, live context surgery, fork-and-steer interrupts, dynamic model switching, permission control, and custom MCP servers.

Deploys on **Docker** (single host) or **Kubernetes** (k3s/k8s) with multi-tenant isolation, Cloudflare Tunnel ingress, and full observability via VictoriaMetrics + VictoriaLogs + Grafana.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) with a patched CLI for background MCP tools, live IPC, session commands, and custom compaction prompts.

**Tested against Claude Code v2.1.74.**

## What This Adds Beyond Stock Claude

| Feature | Stock Claude Code | Agent Runner |
|---------|-------------------|--------------|
| **Multi-session** | Single CLI process | Concurrent isolated sessions via API |
| **Multi-tenant** | N/A | API key auth, per-tenant namespaces, isolated data |
| **k8s deployment** | N/A | k3s/k8s with auto-scaling, RBAC, PVCs |
| **Fork-and-steer** | Wait or abort | Interrupt without losing work — background finishes, foreground handles new message |
| **Live context surgery** | None | Read, inject, remove, truncate, rewind conversation context at runtime via IPC |
| **Background MCP tools** | Sequential | All MCP tool calls run with `run_in_background`, parallel execution via task registry |
| **Independent parallel tools** | Sibling abort on error | Parallel tool calls complete independently |
| **Custom compaction** | Fixed prompt | Inject or fully replace the compact summary prompt per session |
| **Dynamic model switching** | Set at start | Change model, thinking tokens, or compact instructions mid-session |
| **Permission protocol** | Terminal prompt | Programmatic allow/deny/modify via WebSocket |
| **Observability** | None | Prometheus metrics, structured log aggregation, Grafana dashboards |
| **Slash commands in SDK mode** | Not available | `/clear` and `/resume` work in stream-json mode |
| **Rewind** | Not available | Truncate context to any previous turn by UUID |
| **Auto-compaction** | Manual | Orchestrator monitors context % and compacts when idle |
| **MCP server injection** | Config files | Pass MCP servers per session at creation time |
| **Path restrictions** | Config files | Per-session `allowedPaths` enforced via PreToolUse hook |
| **Vault sync** | Not available | Obsidian vault sessions via headless sync — live bidirectional to `/workspace` |
| **Warm pool** | Not available | Pre-spawned containers for near-instant session creation |
| **Cloudflare Tunnel** | N/A | Zero-config external access via sidecar |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  k3s cluster                                                     │
│                                                                   │
│  ┌───────────────────────────────┐  ┌──────────────────────────┐│
│  │ orchestrator (Deployment)     │  │ runner pods              ││
│  │  Hono API            :8080    │  │  warm-pool-xxx (idle)    ││
│  │  Client WS      :8080/ws     │  │  session-abc (busy)      ││
│  │  Runner WS bridge    :8081    │  │  session-def (ready)     ││
│  │  SQLite on PVC                │  │  [per-tenant namespace]  ││
│  │  Token pool (round-robin)     │  └──────────────────────────┘│
│  │  Metrics       /metrics       │                               │
│  │  cloudflared (optional)       │  ┌──────────────────────────┐│
│  └───────────────────────────────┘  │ monitoring namespace     ││
│                                      │  VictoriaMetrics         ││
│  Backends: Docker API or k8s API     │  VictoriaLogs            ││
│  Auth: X-API-Key per tenant          │  Vector (log collector)  ││
│                                      │  Grafana :3000           ││
│                                      └──────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**Docker mode:** Orchestrator uses Docker socket API directly. Single host, simplest setup.

**k8s mode:** Orchestrator uses Kubernetes API via `@kubernetes/client-node`. Multi-node, auto-scheduling, namespace isolation per tenant. Set `RUNNER_BACKEND=k8s`.

## Quick Start

### Docker (simple)

```bash
git clone https://github.com/DigiBugCat/claude-agent-runner.git
cd claude-agent-runner
npm install

# Configure
cp .env.example .env
# Edit .env — at minimum set CLAUDE_CODE_OAUTH_TOKEN

# Build and start
docker compose build --no-cache
docker compose up -d
```

API at `http://localhost:9080`.

### Kubernetes (k3d local)

See [k8s quickstart](k8s/docs/quickstart.md) for the full walkthrough. TL;DR:

```bash
k3d cluster create claude-runner
docker build -t claude-orchestrator:latest -f packages/orchestrator/Dockerfile .
docker build -t claude-runner:latest -f packages/runner/Dockerfile .
k3d image import claude-orchestrator:latest claude-runner:latest -c claude-runner
kubectl apply -k k8s/
```

## Multi-Tenancy

Tenants are project-scoped isolation units — an agent, a user, a team, or a workload. Each tenant gets:
- API key authentication (`X-API-Key` header)
- Isolated k8s namespace (auto-provisioned)
- Separate sessions PVC and secrets
- Soft session capacity limit
- Per-tenant Obsidian vault configuration

Tenants share the global OAuth token pool and cluster resources.

```bash
# Enable tenants
ENABLE_TENANTS=true ADMIN_API_KEY=your-secret

# Create a tenant (admin)
curl -X POST localhost:9080/tenants \
  -H 'X-API-Key: your-secret' \
  -H 'Content-Type: application/json' \
  -d '{"id": "my-project", "name": "My Project", "max_sessions": 5}'
# Returns: { "api_key": "..." } — save this, shown once

# Use tenant key for all operations
curl -X POST localhost:9080/sessions \
  -H 'X-API-Key: <tenant-api-key>' \
  -d '{"message": "hello"}'
```

Tenant API routes: `GET/POST/PATCH/DELETE /tenants`, `POST /tenants/:id/rotate-key`

## WebSocket API

Connect to `ws://localhost:9080/ws` (or `ws://host/ws?key=<api-key>` with tenants enabled).

### Client → Server Frames

| Frame | Key Fields | Description |
|-------|------------|-------------|
| `ping` | — | Keepalive (server replies `pong`) |
| `subscribe` | `session_id` | Subscribe to all events for a session |
| `unsubscribe` | `session_id` | Stop receiving events |
| `send` | `session_id`, `message`, `content?`, `model?`, `max_turns?`, `max_thinking_tokens?` | Send a message to an idle session. Supports multimodal `content` blocks. |
| `steer` | `session_id`, `message`, `mode?`, `model?`, `compact?`, `operations?` | Interrupt or redirect. `mode: "steer"` aborts current turn; `mode: "fork_and_steer"` keeps background running. |
| `compact` | `session_id`, `custom_instructions?` | Force context compaction |
| `rewind` | `session_id`, `user_message_uuid` | Truncate context to the turn before the given UUID |
| `set_options` | `session_id`, `model?`, `max_thinking_tokens?`, `compact_instructions?` | Change model or settings mid-session |
| `permission_response` | `session_id`, `tool_use_id`, `behavior` | Respond to a pending tool permission request |
| `get_commands` | `session_id` | List available slash commands |

### Server → Client Frames

| Frame | Key Fields | Description |
|-------|------------|-------------|
| `pong` | — | Keepalive response |
| `subscribed` | `session_id`, `status` | Subscription confirmed |
| `ack` | `session_id`, `ok`, `error?` | Command acknowledgement |
| `status` | `session_id`, `status` | Lifecycle: `starting` → `ready` → `busy` → `idle` → `stopped` |
| `event` | `session_id`, `event` | Every SDK streaming event (text deltas, tool use, tool results, usage) |
| `context_state` | `session_id`, `context_tokens`, `compacted?` | Context size after each turn or auto-compact |
| `permission_request` | `session_id`, `tool_name`, `tool_use_id`, `input` | Tool needs approval before execution |
| `commands_result` | `session_id`, `commands[]` | Available slash commands |
| `error` | `session_id`, `error_code`, `message` | Runner error |

## REST API

Full OpenAPI 3.1 spec: [`openapi.yaml`](openapi.yaml)

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions` | Create session (blocking) |
| `POST` | `/sessions/stream` | Create session (SSE streaming) |
| `GET` | `/sessions` | List sessions (scoped to tenant) |
| `GET` | `/sessions/:id` | Get session detail |
| `PATCH` | `/sessions/:id` | Rename or pin session |
| `DELETE` | `/sessions/:id` | Stop and remove session |
| `GET` | `/sessions/:id/transcript` | Get JSONL transcript |

### Messages

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions/:id/messages` | Send follow-up message (blocking) |
| `POST` | `/sessions/:id/messages/stream` | Send follow-up message (SSE) |
| `POST` | `/sessions/:id/fork` | Fork session from SDK state |

### Context Surgery

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sessions/:id/context` | Read conversation context |
| `POST` | `/sessions/:id/context/inject` | Inject message into context |
| `DELETE` | `/sessions/:id/context/messages/:uuid` | Remove message by UUID |
| `POST` | `/sessions/:id/context/truncate` | Truncate to last N turns |
| `POST` | `/sessions/:id/context/compact` | Schedule compaction |
| `POST` | `/sessions/:id/context/steer` | Steer or fork-and-steer |

### Tenants

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tenants` | List tenants (admin) or self-info (tenant key) |
| `POST` | `/tenants` | Create tenant (admin) |
| `GET` | `/tenants/:id` | Get tenant detail |
| `PATCH` | `/tenants/:id` | Update tenant config (admin) |
| `DELETE` | `/tenants/:id` | Delete tenant (admin) |
| `POST` | `/tenants/:id/rotate-key` | Rotate API key (admin) |

### Observability

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health, active sessions, token pool, backend status |
| `GET` | `/metrics` | Prometheus-compatible metrics (VictoriaMetrics scrapes this) |

## Observability

The orchestrator exposes 16+ Prometheus-compatible metrics with high-cardinality labels (`model`, `tenant_id`, `source_type`), optimized for VictoriaMetrics.

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `sessions_created_total` | Counter | Sessions created (by model, source, tenant) |
| `sessions_active` | Gauge | Active sessions by status |
| `tokens_consumed_total` | Counter | Input/output tokens consumed |
| `cost_usd_total` | Counter | Estimated cost in USD |
| `spawn_duration_seconds` | Histogram | Time to spawn + ready a runner |
| `message_duration_seconds` | Histogram | Message round-trip time |
| `warm_pool_hits_total` | Counter | Sessions adopted from warm pool |
| `warm_pool_misses_total` | Counter | Cold spawns (no warm entry) |
| `api_requests_total` | Counter | HTTP requests by method/path/status |
| `api_request_duration_seconds` | Histogram | HTTP request latency |
| `ws_connections_active` | Gauge | Active WebSocket connections |
| `runner_errors_total` | Counter | Runner errors by code |

### Monitoring Stack

Deploy VictoriaMetrics + VictoriaLogs + Vector + Grafana:

```bash
kubectl apply -k k8s/monitoring/
kubectl -n monitoring port-forward svc/grafana 3000:3000
# Open http://localhost:3000 (admin/admin)
```

Pre-configured Grafana datasources:
- **VictoriaMetrics** — PromQL queries on scraped metrics
- **VictoriaLogs** — LogsQL queries on structured JSON logs (all orchestrator/runner output)

Vector DaemonSet automatically collects pod stdout, parses JSON fields, and pushes to VictoriaLogs.

## Configuration

All configuration via environment variables. See [`.env.example`](.env.example).

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | OAuth token(s), comma-separated for round-robin |
| `RUNNER_BACKEND` | No | `docker` (default) or `k8s` |
| `RUNNER_IMAGE` | No | Runner image (default: `claude-runner:latest`) |
| `RUNNER_IMAGE_PULL_POLICY` | No | k8s image pull policy (set `Never` for local k3d) |
| `K8S_NAMESPACE` | No | Default k8s namespace (default: `claude-runner`) |
| `ENABLE_TENANTS` | No | Enable multi-tenancy (`true`/`false`) |
| `ADMIN_API_KEY` | No | Admin key for `/tenants` management routes |
| `GIT_TOKEN` | No | GitHub token for cloning private repos |
| `IDLE_TIMEOUT_MS` | No | Idle session timeout in ms (default: `300000`) |
| `MESSAGE_TIMEOUT_MS` | No | Message timeout in ms (default: `600000`) |
| `MAX_ACTIVE_SESSIONS` | No | Max concurrent sessions (default: unlimited) |
| `DB_PATH` | No | SQLite database path (default: `/app/data/orchestrator.db`) |
| `AUTO_COMPACT_THRESHOLD_PCT` | No | Context % threshold for auto-compaction |
| `AUTO_COMPACT_IDLE_SECONDS` | No | Seconds idle before auto-compact fires |
| `WARM_POOL_SIZE` | No | Pre-spawned warm containers (default: `0` = disabled) |
| `RUNNER_CPU_REQUEST` | No | CPU request per runner pod (k8s only, e.g. `500m`) |
| `RUNNER_CPU_LIMIT` | No | CPU limit per runner pod (k8s only, e.g. `2`) |
| `RUNNER_MEMORY_REQUEST` | No | Memory request per runner pod (k8s only, e.g. `512Mi`) |
| `RUNNER_MEMORY_LIMIT` | No | Memory limit per runner pod (k8s only, e.g. `2Gi`) |
| `OBSIDIAN_AUTH_TOKEN` | No | Obsidian sync token (required for vault sessions) |
| `OBSIDIAN_E2EE_PASSWORD` | No | Obsidian E2E encryption password |

## Cloudflare Tunnel

Expose the orchestrator externally without opening ports. See [Cloudflare Tunnel setup guide](k8s/docs/cloudflare-tunnel.md).

The cloudflared sidecar is included in the orchestrator deployment (commented out by default). Create a tunnel, add the token as a k8s secret, uncomment the sidecar, and apply.

## CLI Patches

The runner uses a patched version of Claude Code's CLI. The patching system uses a step-based engine that locates code by content anchors (not minified names), making patches resilient across CLI versions.

### Active Patches

| Patch | Description |
|-------|-------------|
| **`mcp-background`** | `run_in_background: true` for all MCP tool calls |
| **`memory-ipc`** | Unix socket IPC server for live context surgery |
| **`clear-resume`** | `/clear` and `/resume` in SDK stream-json mode |
| **`no-sibling-abort`** | Parallel tool calls complete independently |
| **`compact-instructions`** | Custom compaction prompts via env var |

### After Claude Code Updates

1. Download new CLI: `npm pack @anthropic-ai/claude-code@<version>`, extract `cli.js` to `snapshots/`
2. Dry-run: `bun run scripts/patch-all.js --binary snapshots/cli-<version>.js --js-only --dry-run`
3. If patches pass: update Dockerfile's pinned version, rebuild
4. If a patch fails: update extractors in `spec.json`

## Project Structure

```
packages/
├── shared/            # Shared TypeScript types (API + WS protocol)
├── orchestrator/      # HTTP API + WS + session management
│   └── src/
│       ├── server.ts        # Hono routes + tenant CRUD
│       ├── sessions.ts      # SessionManager (SQLite, tenant-scoped)
│       ├── docker.ts        # DockerManager + ContainerManager interface
│       ├── k8s-manager.ts   # K8sManager (pod CRUD via k8s API)
│       ├── k8s-provisioner.ts # Auto-provisions tenant namespaces/PVCs/secrets
│       ├── tenants.ts       # TenantManager (CRUD, API key auth)
│       ├── auth.ts          # Auth middleware (HTTP + WS)
│       ├── metrics.ts       # Prometheus metrics (prom-client)
│       ├── ws-bridge.ts     # Internal WS bridge to runners (:8081)
│       ├── client-ws.ts     # Client-facing WS API (:8080/ws)
│       ├── auto-compact.ts  # AutoCompactor
│       ├── warm-pool.ts     # WarmPool (works with both backends)
│       ├── token-pool.ts    # OAuth token round-robin
│       └── db.ts            # SQLite schema (sessions + tenants + snapshots)
└── runner/            # Claude Agent SDK wrapper (runs inside Docker/k8s)
    ├── src/           # Runner loop, fork-and-steer, IPC, serialization
    └── patches/       # CLI binary patching system

k8s/
├── namespace.yaml              # claude-runner namespace
├── secrets.yaml                # OAuth tokens, Obsidian auth, git tokens
├── pvc-sessions.yaml           # Sessions PVC (RWO single-node, RWX multi-node)
├── pvc-orchestrator.yaml       # SQLite PVC
├── orchestrator-rbac.yaml      # ClusterRole for cross-namespace management
├── orchestrator-deployment.yaml # Orchestrator + optional cloudflared sidecar
├── orchestrator-service.yaml   # ClusterIP service (8080 + 8081)
├── runner-pod-template.yaml    # Reference spec (K8sManager creates pods programmatically)
├── kustomization.yaml
├── docs/
│   ├── quickstart.md           # Local k3d setup guide
│   └── cloudflare-tunnel.md    # Cloudflare Tunnel setup guide
└── monitoring/
    ├── victoria-metrics.yaml   # Metrics storage + scraping
    ├── victoria-logs.yaml      # Log storage (JSON-native)
    ├── vector.yaml             # Log collection DaemonSet
    ├── grafana.yaml            # Dashboards (pre-configured datasources)
    └── kustomization.yaml
```

## Development

```bash
npm install
npm run typecheck    # Type check all packages
npm test             # Unit tests (vitest) — 195 tests
npm run dev --workspace=packages/orchestrator  # Dev mode
```

## Docker

```bash
# Build via docker compose (recommended)
docker compose build --no-cache

# Or build individually
docker build -f packages/orchestrator/Dockerfile -t claude-orchestrator .
docker build -f packages/runner/Dockerfile -t claude-runner .
```

## CI/CD

Woodpecker CI (`.woodpecker/ci.yaml`):
- **Test:** typecheck + vitest on every push/PR
- **Build:** Docker images built via BuildKit, pushed to local registry (`172.20.0.161:30500`) on main
- **Image tags:** `:latest` and `main-<sha>`
- **CLI version check:** Daily cron (`cli-version-check.yaml`) tests patches against new Claude Code releases

## License

[MIT](LICENSE)

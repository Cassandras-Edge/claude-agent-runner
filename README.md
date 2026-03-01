# Claude Agent Runner

Multi-session Claude Code agent orchestrator. Run concurrent, Docker-isolated Claude agent sessions through a REST API with SSE streaming, live context surgery, and fork-and-steer interrupts.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) with a patched CLI for background MCP tools, live IPC, and session commands.

**Tested against Claude Code v2.1.63.**

## Architecture

```
Client (REST / SSE)
    │
    ▼
┌──────────────────────────────────┐
│  Orchestrator                    │
│  Hono HTTP + WebSocket bridge    │
│  SQLite session persistence      │
│  OAuth token pool (round-robin)  │
│  :8080 REST  :8081 WS bridge     │
└────────────┬─────────────────────┘
             │ Docker API + WS
             ▼
┌──────────────────────────────────┐
│  Runner containers (ephemeral)   │
│  Claude Agent SDK (V2)           │
│  Patched CLI binary              │
│  Git clone + /workspace mount    │
│  IPC socket for live context     │
│  Isolated per session            │
└──────────────────────────────────┘
```

The **orchestrator** manages session lifecycle, spawns Docker containers, and proxies agent events via WebSocket. Each **runner** is a short-lived container running a patched Claude CLI via the Agent SDK against a cloned repo or mounted workspace.

## Quick Start

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

The API is available at `http://localhost:9080`.

## API

Full OpenAPI 3.1 spec: [`openapi.yaml`](openapi.yaml)

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions` | Create session (blocking) |
| `POST` | `/sessions/stream` | Create session (SSE streaming) |
| `GET` | `/sessions` | List all sessions |
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

Live manipulation of the agent's conversation context via IPC to the running CLI process.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sessions/:id/context` | Read conversation context |
| `POST` | `/sessions/:id/context/inject` | Inject message into context |
| `DELETE` | `/sessions/:id/context/messages/:uuid` | Remove message by UUID |
| `POST` | `/sessions/:id/context/truncate` | Truncate to last N turns |
| `POST` | `/sessions/:id/context/compact` | Schedule compaction |

### Steer and Fork-and-Steer

Interrupt a running agent without losing work.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions/:id/context/steer` | Steer or fork-and-steer |

```bash
# Steer: abort current turn and redirect
curl -X POST http://localhost:9080/sessions/<id>/context/steer \
  -H "Content-Type: application/json" \
  -d '{"message": "Stop, do this instead", "mode": "steer"}'

# Fork-and-steer: keep background running, answer in foreground
curl -X POST http://localhost:9080/sessions/<id>/context/steer \
  -H "Content-Type: application/json" \
  -d '{"message": "Quick question while you work", "mode": "fork_and_steer"}'
```

| Mode | Behavior |
|------|----------|
| `steer` | Abort current turn, deliver new message |
| `fork_and_steer` | Background finishes work, new foreground handles the message. Result merged back via IPC when background completes. |

### Snapshots

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sessions/:id/snapshots` | List context snapshots |
| `GET` | `/sessions/:id/snapshots/:snapId` | Get snapshot with messages |
| `POST` | `/sessions/:id/snapshots` | Trigger manual snapshot |

Snapshots are automatically created on steer, compaction, and turn completion.

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health, active sessions, token pool, Docker status |

### Examples

```bash
# Create a session and run a task
curl -X POST http://localhost:9080/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "https://github.com/user/repo",
    "message": "Add input validation to the login endpoint",
    "model": "sonnet"
  }'

# Stream a session with SSE
curl -N -X POST http://localhost:9080/sessions/stream \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "https://github.com/user/repo",
    "message": "Refactor the database module to use connection pooling"
  }'

# Send a follow-up
curl -X POST http://localhost:9080/sessions/<id>/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Now add tests for the changes you made"}'

# Inject context (e.g., add a system hint)
curl -X POST http://localhost:9080/sessions/<id>/context/inject \
  -H "Content-Type: application/json" \
  -d '{"content": "Remember to use the existing test helpers", "role": "user"}'
```

## Configuration

All configuration via environment variables. See [`.env.example`](.env.example).

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | OAuth token(s), comma-separated for round-robin |
| `GIT_TOKEN` | No | GitHub token for cloning private repos |
| `RUNNER_IMAGE` | No | Docker image for runners (default: `claude-runner:latest`) |
| `IDLE_TIMEOUT_MS` | No | Idle session timeout in ms (default: `300000`) |
| `MESSAGE_TIMEOUT_MS` | No | Message timeout in ms (default: `600000`) |
| `MAX_ACTIVE_SESSIONS` | No | Max concurrent sessions (default: `8`) |
| `DB_PATH` | No | SQLite database path (default: `/app/data/orchestrator.db`) |

## Project Structure

```
packages/
├── shared/            # Shared TypeScript types (API + WS protocol)
├── orchestrator/      # HTTP API + session management + Docker orchestration
│   └── src/
│       ├── server.ts        # Hono route definitions
│       ├── sessions.ts      # SessionManager (SQLite-backed)
│       ├── docker.ts        # DockerManager (Dockerode)
│       ├── ws-bridge.ts     # WebSocket bridge to runners
│       ├── token-pool.ts    # OAuth token round-robin
│       └── db.ts            # SQLite schema + snapshots
└── runner/            # Claude Agent SDK wrapper (runs inside Docker)
    ├── src/
    │   ├── index.ts              # Main runner loop
    │   ├── background-drainer.ts # Drains background session to completion
    │   ├── merge-back.ts         # Splices background result into foreground via IPC
    │   ├── mem-ipc.ts            # IPC client for CLI's Unix socket
    │   ├── context.ts            # JSONL context operations (fallback)
    │   └── serialize.ts          # SDK event serialization
    └── patches/       # CLI binary patching system
        ├── lib/                  # Patcher engine
        ├── scripts/              # patch-all.js entry point
        ├── patches/              # Individual patch specs + templates
        └── snapshots/            # CLI binary snapshots (gitignored)
```

## Binary Patches

The runner uses a patched version of Claude Code's CLI. The patching system extracts the JS from the compiled binary, applies modifications via regex-based extractors, and produces `dist/cli-patched.js`.

### Active Patches

| Patch | Type | Description |
|-------|------|-------------|
| `mcp-background` | template | `run_in_background: true` on any MCP tool call, using CLI's internal task registry |
| `memory-ipc` | template | Unix socket IPC server exposing `mutableMessages` for live context surgery |
| `clear-resume` | template | `/clear` and `/resume <id>` commands in stream-json mode |
| `no-sibling-abort` | replacement | Let parallel tool calls complete independently (don't abort siblings on error) |

Template patches use `extractors` (30KB region around a stable anchor string) and `globalExtractors` (full JS scan) to find minified symbols by structural context, not by name. This makes them resilient across CLI versions.

### Applying Patches

```bash
cd packages/runner/patches

# Dry-run against a snapshot
bun run scripts/patch-all.js --binary snapshots/cli-2.1.63.js --js-only --dry-run

# Apply (produces dist/cli-patched.js)
bun run scripts/patch-all.js --binary snapshots/cli-2.1.63.js --js-only

# Against system-installed binary
bun run scripts/patch-all.js --js-only
```

### After Claude Code Updates

1. Download the new CLI JS: `npm pack @anthropic-ai/claude-code@<version>`, extract `cli.js`, copy to `snapshots/cli-<version>.js`
2. Dry-run: `bun run scripts/patch-all.js --binary snapshots/cli-<version>.js --js-only --dry-run`
3. If all patches pass: update the Dockerfile's pinned version, rebuild images
4. If a patch is skipped: update its extractors in `spec.json` (the anchor or regex patterns changed)

## Development

```bash
npm install
npm run typecheck    # Type check all packages
npm test             # Unit tests (vitest)
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

## License

[MIT](LICENSE)

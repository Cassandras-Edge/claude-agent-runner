# Claude Agent Runner

Docker-isolated Claude Code agent runtime. Manage multiple concurrent Claude agent sessions through a REST API with SSE streaming support.

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
│  Claude Agent SDK                │
│  Patched CLI (binary patches)    │
│  Git clone + /workspace mount    │
│  IPC socket for live context     │
│  Isolated per session            │
└──────────────────────────────────┘
```

The **orchestrator** manages session lifecycle, spawns Docker containers, and proxies agent events. Each **runner** is a short-lived container that runs a patched Claude CLI via the Agent SDK against a cloned repo or mounted workspace.

## Features

### Core
- Multi-session management with SQLite persistence
- SSE streaming of agent events in real-time
- Session forking (branch conversation history)
- Context surgery (inject, remove, truncate messages via IPC)
- Context snapshots stored in SQLite
- OAuth token pool with round-robin distribution

### Binary Patches
The runner uses a patched version of Claude Code's CLI (`cli-patched.js`) with:
- **Background MCP tools** — any MCP tool call can run in the background via `run_in_background: true`, using the CLI's internal task registry + `TaskOutput` retrieval
- **Live context IPC** — Unix socket server exposing `mutableMessages` for real-time context surgery (splice, push, get, emit)
- **SDK commands** — `/clear` and `/resume` in stream-json mode

See [patches README](packages/runner/patches/README.md) for details.

### Fork-and-Steer
When the agent is streaming (writing files, thinking, spawning subagents), users can interrupt without losing work:

```
POST /sessions/:id/context/steer
{ "message": "quick question", "mode": "fork_and_steer" }
```

| Mode | Behavior | Use case |
|------|----------|----------|
| `steer` | Abort current turn, deliver message | "Stop, do this instead" |
| `fork_and_steer` | Background finishes work, deliver message in new foreground | "Keep going but also answer me" |

The background session continues the original work. When it completes, the result is merged back into the foreground session's context via IPC splice. Multiple concurrent backgrounds are supported.

See [FORK-AND-STEER.md](packages/runner/patches/FORK-AND-STEER.md) for the full design.

## Quick Start

```bash
# Clone and install
git clone https://github.com/DigiBugCat/claude-agent-runner.git
cd claude-agent-runner
npm install

# Configure
cp .env.example .env
# Edit .env with your CLAUDE_CODE_OAUTH_TOKEN

# Build images
docker compose build --no-cache

# Start
docker compose up -d
```

The orchestrator is available at `http://localhost:9080`.

## API

Full OpenAPI 3.1 spec: [`openapi.yaml`](openapi.yaml)

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/sessions` | List all sessions |
| `POST` | `/sessions` | Create session (blocking) |
| `POST` | `/sessions/stream` | Create session (SSE streaming) |
| `GET` | `/sessions/:id` | Get session detail |
| `PATCH` | `/sessions/:id` | Rename or pin session |
| `DELETE` | `/sessions/:id` | Stop and remove session |
| `GET` | `/sessions/:id/transcript` | Get JSONL transcript |
| `POST` | `/sessions/:id/messages` | Send message (blocking) |
| `POST` | `/sessions/:id/messages/stream` | Send message (SSE streaming) |
| `POST` | `/sessions/:id/fork` | Fork session from snapshot |
| `POST` | `/sessions/:id/context/steer` | Steer or fork-and-steer |
| `GET` | `/sessions/:id/context` | Read conversation context |
| `POST` | `/sessions/:id/context/inject` | Inject message into context |
| `DELETE` | `/sessions/:id/context/messages/:uuid` | Remove message from context |
| `POST` | `/sessions/:id/context/truncate` | Truncate to last N turns |
| `POST` | `/sessions/:id/context/compact` | Schedule compaction |
| `GET` | `/sessions/:id/snapshots` | List context snapshots |
| `POST` | `/sessions/:id/snapshots` | Trigger manual snapshot |

### Examples

Create a session and run a task:

```bash
curl -X POST http://localhost:9080/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "https://github.com/user/repo",
    "message": "Add input validation to the login endpoint",
    "model": "sonnet"
  }'
```

Stream a session with SSE:

```bash
curl -N -X POST http://localhost:9080/sessions/stream \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "https://github.com/user/repo",
    "message": "Refactor the database module to use connection pooling"
  }'
```

Send a follow-up message:

```bash
curl -X POST http://localhost:9080/sessions/<session_id>/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Now add tests for the changes you made"}'
```

Fork-and-steer (interrupt a busy session without losing work):

```bash
# While the session is busy writing code...
curl -X POST http://localhost:9080/sessions/<session_id>/context/steer \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Quick question: where is the config file?",
    "mode": "fork_and_steer"
  }'
# Returns immediately. Background continues. Foreground answers your question.
```

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

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
└── runner/            # Claude Agent SDK wrapper (runs inside Docker)
    ├── src/           # Runner application code
    │   ├── index.ts              # Main runner (session, steer, fork-and-steer)
    │   ├── background-drainer.ts # Drains background session stream to completion
    │   ├── merge-back.ts         # Splices background results into foreground via IPC
    │   ├── mem-ipc.ts            # IPC client for Claude CLI's Unix socket
    │   ├── context.ts            # JSONL-based context operations (fallback)
    │   ├── serialize.ts          # SDK event serialization
    │   └── __tests__/            # Vitest unit tests
    └── patches/       # Claude Code binary patching system
        ├── lib/                  # Patcher engine (extraction, replacement, template)
        ├── scripts/              # patch-all.js entry point
        ├── patches/              # Individual patch specs + templates
        │   ├── mcp-background/   # Background MCP tools (globalExtractors)
        │   ├── memory-ipc/       # Unix socket IPC server
        │   └── clear-resume/     # /clear and /resume in SDK mode
        ├── snapshots/            # Gitignored CLI binary + extracted JS
        ├── tools/                # Exploration utilities (extract, probe, strip)
        └── test-mcp-bg/          # Integration tests
```

## Binary Patches

Claude Code is a Bun-compiled binary with embedded JavaScript. The patching system extracts the JS, applies modifications, and produces a patched `cli-patched.js` for SDK usage.

### Patch Types

| Type | Description |
|------|-------------|
| **replacement** | Same-length string swap. Works on binary + JS. Fragile (breaks when minified code changes). |
| **template** | Version-resilient insertion. Uses regex extractors to derive minified variable names from stable structural patterns. |

Template patches use `extractors` (30KB region around anchor) and `globalExtractors` (full 10MB JS scan) to find minified symbols by their structural context, not their names.

### Applying Patches

```bash
cd packages/runner/patches

# Against a snapshot (recommended for dev)
bun run scripts/patch-all.js --binary snapshots/claude-2.1.52 --js-only --dry-run

# Against system binary
bun run scripts/patch-all.js --js-only

# Full apply (produces dist/cli-patched.js)
bun run scripts/patch-all.js --binary snapshots/claude-2.1.52 --js-only
```

### After Claude Code Updates

1. Copy the new binary to `snapshots/claude-<version>`
2. Run `bun run scripts/patch-all.js --binary snapshots/claude-<version> --js-only --dry-run`
3. If all patches apply: done. Rebuild Docker images.
4. If a patch is skipped: update the extractors in its `spec.json` (see each patch's `README.md`)

Template patches with `globalExtractors` are designed to survive most CLI updates — they match on stable strings (error messages, property names, protocol methods) rather than minified variable names.

## Development

```bash
# Install dependencies
npm install

# Type check all packages
npm run typecheck

# Run tests
npm test

# Run with coverage
npm run test:coverage

# Dev mode (orchestrator)
npm run dev --workspace=packages/orchestrator
```

## Building Docker Images

```bash
# Build via docker compose (recommended)
docker compose build --no-cache

# Or build individually
docker build -f packages/orchestrator/Dockerfile -t claude-orchestrator .
docker build -f packages/runner/Dockerfile -t claude-runner .
```

## Testing

```bash
# Unit tests (all packages)
npm test

# Fork-and-steer unit tests
npx vitest run packages/runner/src/__tests__/fork-and-steer.test.ts

# E2E fork-and-steer (requires docker compose up)
bash packages/runner/patches/test-mcp-bg/test-fork-and-steer.sh

# MCP background integration test (requires API key)
cd packages/runner/patches/test-mcp-bg && node test-bg.mjs

# Fork() proof-of-concept (requires Docker/Linux)
cd packages/runner/patches/test-mcp-bg
docker build -f Dockerfile.fork-test -t fork-test . && docker run --rm fork-test
```

## License

[MIT](LICENSE)

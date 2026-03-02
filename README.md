# Claude Agent Runner

Multi-session Claude Code agent orchestrator. Run concurrent, Docker-isolated Claude agent sessions through a REST + WebSocket API with streaming events, live context surgery, fork-and-steer interrupts, dynamic model switching, permission control, and custom MCP servers.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) with a patched CLI for background MCP tools, live IPC, session commands, and custom compaction prompts.

**Tested against Claude Code v2.1.63.**

## What This Adds Beyond Stock Claude

| Feature | Stock Claude Code | Agent Runner |
|---------|-------------------|--------------|
| **Multi-session** | Single CLI process | Concurrent isolated Docker sessions via API |
| **Fork-and-steer** | Wait or abort | Interrupt without losing work — background finishes, foreground handles new message |
| **Live context surgery** | None | Read, inject, remove, truncate, rewind conversation context at runtime via IPC |
| **Background MCP tools** | Sequential | All MCP tool calls run with `run_in_background`, parallel execution via task registry |
| **Independent parallel tools** | Sibling abort on error | Parallel tool calls complete independently |
| **Custom compaction** | Fixed prompt | Inject or fully replace the compact summary prompt per session |
| **Dynamic model switching** | Set at start | Change model, thinking tokens, or compact instructions mid-session |
| **Permission protocol** | Terminal prompt | Programmatic allow/deny/modify via WebSocket |
| **Slash commands in SDK mode** | Not available | `/clear` and `/resume` work in stream-json mode |
| **Rewind** | Not available | Truncate context to any previous turn by UUID |
| **Auto-compaction** | Manual | Orchestrator monitors context % and compacts when idle |
| **MCP server injection** | Config files | Pass MCP servers per session at creation time |
| **Path restrictions** | Config files | Per-session `allowedPaths` enforced via PreToolUse hook |

## Architecture

```
Client (REST / SSE / WebSocket)
    │
    ▼
┌──────────────────────────────────┐
│  Orchestrator                    │
│  Hono HTTP API       :8080 REST  │
│  Client WebSocket    :8080 /ws   │
│  Runner WS bridge    :8081       │
│  SQLite session persistence      │
│  OAuth token pool (round-robin)  │
│  Auto-compactor                  │
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

The **orchestrator** manages session lifecycle, spawns Docker containers, and proxies agent events to clients via both REST (SSE) and WebSocket. Each **runner** is a short-lived container running a patched Claude CLI via the Agent SDK against a cloned repo or mounted workspace.

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

## WebSocket API

Connect to `ws://localhost:9080/ws` for real-time bidirectional communication with sessions.

### Client → Server Frames

| Frame | Key Fields | Description |
|-------|------------|-------------|
| `ping` | — | Keepalive (server replies `pong`) |
| `subscribe` | `session_id` | Subscribe to all events for a session |
| `unsubscribe` | `session_id` | Stop receiving events |
| `send` | `session_id`, `message`, `content?`, `model?`, `max_turns?`, `max_thinking_tokens?` | Send a message to an idle session. Supports multimodal `content` blocks. |
| `steer` | `session_id`, `message`, `mode?`, `model?`, `compact?`, `operations?` | Interrupt or redirect. `mode: "steer"` aborts current turn; `mode: "fork_and_steer"` keeps background running. Also works on idle sessions. |
| `compact` | `session_id`, `custom_instructions?` | Force context compaction |
| `rewind` | `session_id`, `user_message_uuid` | Truncate context to the turn before the given UUID |
| `set_options` | `session_id`, `model?`, `max_thinking_tokens?`, `compact_instructions?` | Change model or settings mid-session (takes effect next turn) |
| `permission_response` | `session_id`, `tool_use_id`, `behavior` | Respond to a pending tool permission request (`allow`/`deny`/`allowWithModification`) |
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

### Multimodal Content

The `send` and `steer` frames accept an optional `content` array for multimodal messages:

```json
{
  "type": "send",
  "session_id": "abc",
  "content": [
    { "type": "text", "text": "What's in this image?" },
    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
  ]
}
```

### Permission Protocol

When `permissionMode` is not `bypassPermissions`, tool calls require client approval:

1. Server sends `permission_request` with `tool_name`, `tool_use_id`, and `input`
2. Client sends `permission_response` with `behavior`:
   - `allow` — proceed with the tool call
   - `deny` — block it (optional `message` for reason)
   - `allowWithModification` — proceed with `updated_input`

### Fork-and-Steer via WebSocket

```json
// Interrupt a busy agent without losing its work
{
  "type": "steer",
  "session_id": "abc",
  "message": "Quick question while you work on that",
  "mode": "fork_and_steer"
}
```

The original session finishes in the background. A new forked session handles the message in the foreground. When the background completes, its result is merged back into the foreground context via IPC.

## REST API

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
# Create a session with MCP servers and path restrictions
curl -X POST http://localhost:9080/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "https://github.com/user/repo",
    "message": "Add input validation to the login endpoint",
    "model": "sonnet",
    "mcpServers": {
      "my-server": { "command": "npx", "args": ["-y", "my-mcp-server"] }
    },
    "allowedPaths": ["/workspace/src"],
    "permissionMode": "bypassPermissions"
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
| `AUTO_COMPACT_THRESHOLD_PCT` | No | Context % threshold for auto-compaction |
| `AUTO_COMPACT_IDLE_SECONDS` | No | Seconds idle before auto-compact fires |

## CLI Patches

The runner uses a patched version of Claude Code's CLI. The patching system uses a step-based engine that locates code by content anchors (not minified names), making patches resilient across CLI versions.

### Patch Engine

Specs live in `packages/runner/patches/patches/<name>/spec.json` and use ordered `steps` arrays. The engine (`lib/engine.js`) supports these step types:

| Step Type | Description |
|-----------|-------------|
| `extract` | Locate minified symbols by regex within a global or anchored region |
| `find_replace` | Literal or regex find-and-replace with optional byte-length padding |
| `insert_after` / `insert_before` | Inject template code after/before a matched location |
| `find_function` | Locate a function by content anchor (not by name) |
| `replace_in_function` | Replace code within a function found by `find_function` |
| `wrap_function` | Wrap a found function with additional logic |

### Active Patches

| Patch | Description |
|-------|-------------|
| **`mcp-background`** | Adds `run_in_background: true` to all MCP tool calls using the CLI's internal task registry. Enables parallel MCP tool execution. |
| **`memory-ipc`** | Starts a Unix socket IPC server exposing `mutableMessages` for live context surgery — supports `get_messages`, `push`, `splice`, `emit`, and `session_id` commands. |
| **`clear-resume`** | Enables `/clear` and `/resume <id>` slash commands in stream-json (SDK) mode, which are normally only available in interactive terminal mode. |
| **`no-sibling-abort`** | Removes the sibling tool call abort logic so parallel tool calls succeed or fail independently rather than aborting all siblings when one errors. |
| **`compact-instructions`** | Injects custom compaction prompts from `RUNNER_COMPACT_INSTRUCTIONS` env var. Prefix with `replace:` to fully replace the default prompt, or omit to append as additional instructions. |

### Disabled Patches

| Patch | Description |
|-------|-------------|
| **`webfetch-skip-haiku`** | Would skip Haiku summarization in WebFetch and return raw markdown. Disabled. |

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

## Project Structure

```
packages/
├── shared/            # Shared TypeScript types (API + WS protocol)
├── orchestrator/      # HTTP API + WS + session management + Docker orchestration
│   └── src/
│       ├── server.ts        # Hono route definitions
│       ├── sessions.ts      # SessionManager (SQLite-backed)
│       ├── docker.ts        # DockerManager (Dockerode)
│       ├── ws-bridge.ts     # Internal WS bridge to runners (:8081)
│       ├── client-ws.ts     # Client-facing WS API (:8080/ws)
│       ├── auto-compact.ts  # AutoCompactor (context % monitoring)
│       ├── token-pool.ts    # OAuth token round-robin
│       └── db.ts            # SQLite schema + snapshots
└── runner/            # Claude Agent SDK wrapper (runs inside Docker)
    ├── src/
    │   ├── index.ts              # Main runner loop + permission protocol
    │   ├── background-drainer.ts # Drains background session to completion
    │   ├── merge-back.ts         # Splices background result into foreground via IPC
    │   ├── mem-ipc.ts            # IPC client for CLI's Unix socket
    │   ├── context.ts            # JSONL context operations (fallback)
    │   └── serialize.ts          # SDK event serialization (incl. usage)
    └── patches/       # CLI binary patching system
        ├── lib/                  # Step-based patch engine + diagnostics
        ├── scripts/              # patch-all.js entry point
        ├── patches/              # Individual patch specs + templates
        └── snapshots/            # CLI binary snapshots (gitignored)
```

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

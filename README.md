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
│  Git clone + /workspace mount    │
│  Isolated per session            │
└──────────────────────────────────┘
```

The **orchestrator** manages session lifecycle, spawns Docker containers, and proxies agent events. Each **runner** is a short-lived container that runs the Claude Agent SDK against a cloned repo or mounted workspace.

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
docker compose build

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
| `PATCH` | `/sessions/:id` | Rename session |
| `DELETE` | `/sessions/:id` | Stop and remove session |
| `GET` | `/sessions/:id/transcript` | Get JSONL transcript |
| `POST` | `/sessions/:id/messages` | Send message (blocking) |
| `POST` | `/sessions/:id/messages/stream` | Send message (SSE streaming) |
| `POST` | `/sessions/:id/fork` | Fork session |

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
├── shared/         # Shared TypeScript types (API + WS protocol)
├── orchestrator/   # HTTP API + session management + Docker orchestration
└── runner/         # Claude Agent SDK wrapper (runs inside Docker)
```

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
# Build both images from repo root
docker build -f packages/orchestrator/Dockerfile -t claude-orchestrator .
docker build -f packages/runner/Dockerfile -t claude-runner .
```

Docker images are automatically built and pushed to GitHub Container Registry on push to `main` and version tags via [GitHub Actions](.github/workflows/docker.yml).

## License

[MIT](LICENSE)

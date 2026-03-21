# CLAUDE.md — Claude Agent Runner

## What This Is

Multi-session Claude Code agent orchestrator. Wraps the Claude Agent SDK in Docker/k8s containers with REST + WebSocket APIs, streaming events, context surgery, fork-and-steer, permission protocol, and a patched CLI for background MCP tools and live IPC.

**The runner is fully standalone.** Cassandra-obsidian (or any other client) is just an API consumer — zero code dependencies flow from clients into this repo.

## Package Layout

npm workspaces — three packages in one repo, producing two Docker images.

```
packages/
├── shared/          # Protocol types (OrchestratorCommand, RunnerMessage, etc.)
├── orchestrator/    # HTTP API + WS server + session lifecycle + container management
└── runner/          # Claude Agent SDK wrapper, runs inside Docker/k8s pods
    └── patches/     # CLI binary patching system (version-pinned)
```

Build order matters: **shared → runner, shared → orchestrator** (shared is a dependency of both).

k8s deployment manifests live in the **cassandra-k8s** repo (separate repo, ArgoCD watches it). This repo is app code + CI only.

## Commands

```bash
npm install          # Install all workspaces
npm run typecheck    # Type check all packages
npm test             # Unit tests (vitest, ~271 tests)
npm run test:watch   # Watch mode

# Per-package
npm run dev --workspace=packages/orchestrator    # Dev mode (orchestrator)
npm run build --workspace=packages/shared        # Build shared types
npm run build --workspace=packages/runner         # Build runner
npm run build --workspace=packages/orchestrator   # Build orchestrator

# Docker
docker compose build --no-cache                   # Build both images
docker compose up -d                              # Start orchestrator (Docker mode)

# Individual image builds
docker build -f packages/orchestrator/Dockerfile -t claude-orchestrator .
docker build -f packages/runner/Dockerfile -t claude-runner .
```

## Architecture

Two processes, two Docker images:

**Orchestrator** (HTTP/WS server, manages containers):
- Hono API on `:8080` (REST + client WebSocket at `/ws`)
- Internal WS bridge on `:8081` (runners connect back here)
- SQLite for session/tenant state
- Spawns runner containers via Docker API or k8s API
- Token pool (round-robin across multiple OAuth tokens)
- Warm pool (pre-spawned containers for fast session creation)
- Auto-compaction (monitors context % and compacts when idle)

**Runner** (one per session, runs inside a container):
- Wraps `unstable_v2_createSession`/`unstable_v2_resumeSession` from Claude Agent SDK
- Connects back to orchestrator via WebSocket on startup
- Uses patched CLI (`cli-patched.js`) via bun for token-level streaming
- Optional: git clone, Obsidian vault sync, MCP servers — all env-gated

## Patch System

The runner patches Claude Code's CLI/SDK at build time. **This is the most fragile part of the system.**

### Pinned Version

Currently pinned to `@anthropic-ai/claude-code@2.1.77` (set in `packages/runner/Dockerfile` lines 5 and 42).

### Active Patches (in `packages/runner/patches/patches/`)

| Patch | What it does |
|-------|-------------|
| `mcp-background` | All MCP tool calls get `run_in_background: true`, parallel via task registry |
| `memory-ipc` | Unix socket IPC server for live context read/write (mutableMessages) |
| `clear-resume` | `/clear` and `/resume` in SDK stream-json mode |
| `compact-instructions` | Custom compaction prompts via `RUNNER_COMPACT_INSTRUCTIONS` env var |
| `compact-model-override` | Use a different model for compaction via `RUNNER_COMPACT_MODEL` env var (defaults to Sonnet 4.6) |

### Inline Patches (in Dockerfile, not in patch system)

Two additional patches are applied directly in the Dockerfile via `sed`/`node -e`:

1. **SDK patch** (line 63): `includePartialMessages:!1` → `includePartialMessages:Q.includePartialMessages??!1` in `sdk.mjs` — enables token-level streaming in V2
2. **CLI patch** (lines 78-87): removes `!s||` from `--include-partial-messages` guard — relaxes --print requirement

These are **version-specific string replacements** — they break if the minified variable names change.

### Upgrading CLI Version

The `cli-version-check.yaml` Woodpecker cron pipeline handles this automatically (daily cron):
1. Checks npm for new `@anthropic-ai/claude-code` versions
2. Dry-runs all patches against the new CLI
3. If all pass: builds images, runs E2E test, creates auto-merge PR
4. If patches break: creates an issue and uses `claude-code-action` to attempt fixes

Manual upgrade:
```bash
# Download new CLI
npm pack @anthropic-ai/claude-code@<version> --pack-destination /tmp
tar xzf /tmp/anthropic-ai-claude-code-*.tgz -C /tmp/claude-code

# Test patches against new CLI
cd packages/runner/patches
bun run scripts/patch-all.js --binary /tmp/claude-code/package/cli.js --js-only --dry-run

# If all pass: update Dockerfile version pins (2 lines), rebuild
# If patches break: fix extractors (see "Fixing Broken Patches" below)
# Also check inline Dockerfile patches (see below)
```

### Patch Step Types

| Step Type | What it does | Scope |
|-----------|-------------|-------|
| `extract` | Regex capture → store in variable. `scope: "global"` searches all 11MB, `scope: "region"` searches 30KB around `anchor` | Read-only |
| `find_replace` | Literal or regex find/replace on full JS content | Global |
| `find_function` | Locate a function by a unique string inside its body, store boundaries | Read-only |
| `replace_in_function` | Find/replace scoped to function boundaries from `find_function` | Scoped |
| `insert_after` / `insert_before` | Inject code at a marker string | JS-only |

Variables from `extract` and `find_function` steps are available in later steps via `{{VAR_NAME}}` interpolation.

### Fixing Broken Patches

When a patch breaks on a new CLI version, the minified variable/function names changed. The fix process:

**1. Get the new CLI source:**
```bash
npm pack @anthropic-ai/claude-code@<version> --pack-destination /tmp
mkdir -p /tmp/claude-code && tar xzf /tmp/anthropic-ai-claude-code-*.tgz -C /tmp/claude-code
```

**2. Identify what broke** — the dry-run output tells you which step failed and shows the regex that didn't match.

**3. Find the equivalent code in the new CLI** — Use stable strings (error messages, property names, string literals) as anchors to locate the same code region:
```bash
# Search for stable strings near the broken pattern
grep -o '.\{80\}STABLE_STRING.\{80\}' /tmp/claude-code/package/cli.js
```

**What's stable across CLI versions** (safe for anchors/extractors):
- Error message strings: `"only prompt commands are supported in streaming mode"`
- Property names: `mutableMessages:`, `session_id:`, `originalMcpToolName:`
- String literals: `"stream-json"`, `"task_started"`, `"compact_boundary"`
- Method calls: `.enqueue(`, `.randomUUID()`, `.push(`
- Structural patterns: `outputOffset:0,notified:!1`

**What changes every build** (must be derived via extractors):
- Local variable names: `r`, `HT`, `I`, `E`, `kR`
- Function names: `mXR`, `b00`, `P00`
- Class names: `P00`, `amT`

**4. Update the extractor regex** — Adjust the regex pattern to match the new minified code structure. The capture group `(\w+)` should still grab the right variable name.

**5. Test the fix:**
```bash
cd packages/runner/patches
bun run scripts/patch-all.js --binary /tmp/claude-code/package/cli.js --js-only --dry-run
```

**6. Update `tested_versions`** in `spec.json` and Dockerfile version pins.

### Inline Dockerfile Patches

Two patches are applied directly in the Dockerfile (not through the patch system). These are **version-specific string replacements** — they break if minified variable names change.

1. **SDK patch** (Dockerfile line 63): `includePartialMessages:!1` → `includePartialMessages:Q.includePartialMessages??!1` in `sdk.mjs` — enables token-level streaming in V2
2. **CLI patch** (Dockerfile lines 78-87): removes `!s||` from `--include-partial-messages` guard — relaxes --print requirement

To check these against a new version:
```bash
# Check SDK patch (look at the installed sdk.mjs)
grep 'includePartialMessages:!1' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs

# Check CLI patch (look for the guard pattern in the patched CLI)
grep 'if(T6){if(!s||h!==' /tmp/claude-code/package/cli.js
```

If the exact strings aren't found, examine the new sdk.mjs / cli.js to find the equivalent patterns.

## Obsidian Integration (Optional)

These features activate only when `vault` is passed in the session request:

- **Vault sync**: uses `obsidian-headless` CLI (`ob`) to set up bidirectional Obsidian Sync in `/workspace`
- **Suggest folder**: `POST /sessions/:id/suggest-folder` — Haiku utility query to suggest vault folder for a note
- **Generate title**: `POST /sessions/:id/generate-title` — Haiku utility query for session titles
- **Warm pool keying**: vault sessions get vault-specific warm containers
- **Credentials**: `OBSIDIAN_AUTH_TOKEN` and `OBSIDIAN_E2EE_PASSWORD` fetched per-tenant from the auth store (set via portal UI)

Without vault config, the runner works as a plain git-clone-and-code agent.

## Environment Variables

### Required

| Variable | Where | Description |
|----------|-------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Orchestrator | OAuth token(s), comma-separated for round-robin |

### Important Optional

| Variable | Where | Default | Description |
|----------|-------|---------|-------------|
| `RUNNER_BACKEND` | Orchestrator | `docker` | `docker` or `k8s` |
| `RUNNER_IMAGE` | Orchestrator | `claude-runner:latest` | Runner container image |
| `RUNNER_IMAGE_PULL_POLICY` | Orchestrator | — | k8s image pull policy (`Never` for local k3d) |
| `DOCKER_NETWORK` | Orchestrator | `claude-net` | Docker network name |
| `ORCHESTRATOR_HOST` | Orchestrator | `host.docker.internal` | Hostname runners use to reach orchestrator |
| `MAX_ACTIVE_SESSIONS` | Orchestrator | unlimited | Concurrent session cap |
| `WARM_POOL_SIZE` | Orchestrator | `0` | Pre-spawned warm containers |
| `ENABLE_TENANTS` | Orchestrator | `false` | Multi-tenancy mode |
| `ADMIN_API_KEY` | Orchestrator | — | Admin key for `/tenants` routes |
| `AUTH_URL` | Orchestrator | — | Auth store URL (for per-tenant credentials) |
| `AUTH_SECRET` | Orchestrator | — | Auth store shared secret |

See `.env.example` for the full list.

## CI/CD

### Woodpecker Pipelines (`.woodpecker/`)

| Pipeline | Trigger | What it does |
|----------|---------|-------------|
| `ci.yaml` | Push to main, PRs | Test + type-check → build + push to local registry (`172.20.0.161:30500`) |
| `cli-version-check.yaml` | Daily cron (9am UTC) | Check for new CLI versions, test patches, auto-PR or issue |

### Image Tags

- `:latest` on main pushes and version tags
- `main-<sha>` on main pushes

Images are pushed to the local registry (`172.20.0.161:30500`) with `:latest` and `main-<sha>` tags. ArgoCD syncs Helm charts using `:latest` with `pullPolicy: Always`.

### What's NOT Automated

- **Inline patch validation**: the two Dockerfile sed/node patches aren't tested in the patch dry-run

## Deployment

### GitOps (production — recommended)

k8s manifests live in the **cassandra-k8s** repo. ArgoCD watches that repo and auto-deploys.

Woodpecker CI (`ci.yaml`) builds images and pushes `:latest` to the local registry. Pods pick up new images on next creation (`pullPolicy: Always`).

See `cassandra-k8s/docs/setup.md` for the full setup guide.

### Docker (single host, dev)

```bash
cp .env.example .env
# Edit .env — set CLAUDE_CODE_OAUTH_TOKEN at minimum
docker compose build --no-cache
docker compose up -d
# API at http://localhost:9080
```

## Testing

```bash
npm test                                    # All tests
npm run test:runner                         # Runner tests only
npm run test:orchestrator                   # Orchestrator tests only

# Patch system
cd packages/runner/patches
bun run scripts/patch-all.js --js-only --dry-run   # Verify patches apply
```

## Fragile Bits / Known Gotchas

1. **Inline Dockerfile patches** (lines 63, 78-87) are string-matched against minified code — they break on CLI updates. The `cli-version-check` workflow doesn't test these.
2. **Patch extractors** use regex against minified JS — stable across minor versions but may break on major refactors.
3. **`obsidian-headless`** is installed globally in the runner image — if the `ob` CLI changes, vault sync breaks.
4. **Docker socket mount** — orchestrator needs `/var/run/docker.sock` in Docker mode. In k8s mode it uses the k8s API instead.
5. **Token streaming** depends on two patches working together (SDK `includePartialMessages` + CLI `--include-partial-messages` guard removal). If either breaks, you get turn-level streaming only (functional but laggy).

## Development Notes

- No `console.*` — use structured logger from `packages/runner/src/logger.ts`
- Shared types are the protocol contract — changes here affect both orchestrator and runner
- The runner is stateless (session state lives in JSONL files on a shared volume)
- The orchestrator is the only process with a database (SQLite)
- WebSocket bridge (`:8081`) is internal only — clients connect to `:8080/ws`

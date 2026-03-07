# Refactor: Split `packages/runner/src/index.ts` into modules

## Goal
Split the 1850-line `packages/runner/src/index.ts` god file into focused modules. The compiled output must be **functionally identical** — this is a pure structural refactor with zero behavioral changes.

## Verification
After the refactor, run:
```bash
npm run typecheck
npm test          # 271 tests must pass
npm run build
```

## Shared Mutable State Strategy

The current file uses ~25 module-level `let` variables as shared mutable state. ESM doesn't allow re-exporting mutable bindings, so use a **shared state object**:

Create `src/state.ts` that exports a single mutable `state` object containing all runtime state. All modules import `state` from `./state.js` and read/write through it (e.g., `state.session`, `state.isBusy`).

```typescript
// state.ts — all mutable runtime state
import type { SDKSession } from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcess } from "child_process";
import type { MemIpcClient } from "./mem-ipc.js";
import type { query } from "@anthropic-ai/claude-agent-sdk";

export interface BackgroundSession {
  drainPromise: Promise<any>;
  abortController: AbortController;
}

export const state = {
  // Identity (changes on adopt)
  SESSION_ID: "",

  // Source config (changes on adopt)
  REPO: undefined as string | undefined,
  BRANCH: "main",
  GIT_TOKEN: undefined as string | undefined,
  VAULT: undefined as string | undefined,
  WORKSPACE: "/workspace",

  // Agent config (changes on adopt or set_options)
  MODEL: "sonnet",
  SYSTEM_PROMPT: undefined as string | undefined,
  APPEND_SYSTEM_PROMPT: undefined as string | undefined,
  MAX_TURNS: undefined as number | undefined,
  THINKING: false,
  ALLOWED_TOOLS: [] as string[],
  DISALLOWED_TOOLS: [] as string[],
  COMPACT_INSTRUCTIONS: undefined as string | undefined,
  PERMISSION_MODE: "bypassPermissions",
  MCP_SERVERS: {} as Record<string, { command: string; args?: string[] }>,
  ALLOWED_PATHS: [] as string[],
  MEM_SOCKET_PATH: "/tmp/claude-mem.sock",

  // Session runtime
  sdkSessionId: undefined as string | undefined,
  session: null as SDKSession | null,
  ipc: null as MemIpcClient | null,
  setupCompleted: false,
  isBusy: false,
  forceCompactOnNextQuery: false,
  pendingCompactInstructions: undefined as string | undefined,
  activeCompactInstructions: undefined as string | undefined,
  activeResponse: null as any, // ReturnType<typeof query> | null
  vaultSyncProcess: null as ChildProcess | null,

  pendingSteer: null as {
    message: string; content?: any[]; model?: string; maxTurns?: number;
    maxThinkingTokens?: number; compact?: boolean; compactInstructions?: string;
    requestId?: string; traceId?: string;
  } | null,

  pendingForkAndSteer: null as {
    message: string; content?: any[]; model?: string; maxTurns?: number;
    maxThinkingTokens?: number; requestId?: string; traceId?: string;
  } | null,

  backgroundSessions: new Map<string, BackgroundSession>(),
  pendingPermissionRequests: new Map<string, (result: { behavior: string; message?: string; updatedInput?: any }) => void>(),
};
```

Initialize state values from env in `config.ts`, then `index.ts` calls `initConfig()` before anything else.

## Target File Structure

```
packages/runner/src/
├── index.ts              # ~30 lines: import config, import connect, start
├── config.ts             # Env parsing, populates state. Exports immutable constants.
├── state.ts              # Shared mutable state object (above)
├── source-prep.ts        # cloneRepo(), syncVault(), stopVaultSync()
├── session-lifecycle.ts  # buildSessionOptions(), createOrResumeSession(), ensureIpcConnected()
├── run-turn.ts           # runTurn() function
├── context-ops.ts        # executeContextOp(), executeContextOpViaIpc(), executeContextOpJsonl(), emitSnapshot()
├── command-handler.ts    # handleMessage() dispatch + per-type handler functions
├── helpers.ts            # buildClaudeChildEnv(), getJsonlPath() (ALREADY EXISTS — merge into it)
├── logger.ts             # (unchanged)
├── serialize.ts          # (unchanged)
├── context.ts            # (unchanged)
├── mem-ipc.ts            # (unchanged)
├── background-drainer.ts # (unchanged)
└── merge-back.ts         # (unchanged)
```

## File-by-file extraction guide

### `config.ts` — Lines 26-86 of index.ts

Extract immutable constants:
```typescript
export const ORCHESTRATOR_URL = process.env.RUNNER_ORCHESTRATOR_URL;
export const FORK_FROM = process.env.RUNNER_FORK_FROM;
export const FORK_AT = process.env.RUNNER_FORK_AT;
export const FORK_SESSION = process.env.RUNNER_FORK_SESSION === "true";
export const FIRST_EVENT_TIMEOUT_MS = parseInt(process.env.RUNNER_FIRST_EVENT_TIMEOUT_MS || "90000", 10);
export const COMPACT_THRESHOLD_PCT = parseInt(process.env.RUNNER_COMPACT_THRESHOLD_PCT || "20", 10);
export const ADDITIONAL_DIRECTORIES: string[] = ...;
export const PATCHED_CLI_PATH = process.env.CLAUDE_PATCHED_CLI || undefined;
```

Export `initConfig()` function that populates `state.*` from env vars. Called once by `index.ts` at startup.

### `source-prep.ts` — Lines 88-218 of index.ts

Move these functions:
- `cloneRepo()` — uses `state.REPO`, `state.BRANCH`, `state.GIT_TOKEN`, `state.WORKSPACE`, `state.SESSION_ID`
- `syncVault()` — uses `state.VAULT`, `state.WORKSPACE`, `state.SESSION_ID`, `state.vaultSyncProcess`
- `stopVaultSync()` — uses `state.VAULT`, `state.vaultSyncProcess`

All read/write from `state` import.

### `session-lifecycle.ts` — Lines 302-430 of index.ts

Move these functions:
- `buildSessionOptions(forceCompact, ws)` — reads many state fields, returns SDKSessionOptions
- `createOrResumeSession(ws)` — creates/resumes SDK session, sets `state.session`, `state.sdkSessionId`
- `ensureIpcConnected()` — connects IPC, sets `state.ipc`

Imports: `state`, `config` (for FORK_FROM, FORK_AT, etc.), helpers, logger, SDK types

### `run-turn.ts` — Lines 434-850 of index.ts

Move `runTurn()` function. This is the biggest single function (~400 lines).

It reads/writes: `state.session`, `state.isBusy`, `state.sdkSessionId`, `state.forceCompactOnNextQuery`, `state.pendingSteer`, `state.pendingForkAndSteer`, `state.activeResponse`, `state.backgroundSessions`, `state.pendingPermissionRequests`

Also calls: `createOrResumeSession()`, `ensureIpcConnected()`, `emitSnapshot()`, `serializeEvent()`, `drainBackground()`, `mergeBackResult()`

### `context-ops.ts` — Lines 838-970 of index.ts

Move these functions:
- `executeContextOpViaIpc(op)` — uses `state.ipc`
- `executeContextOpJsonl(op)` — uses `getJsonlPath()`
- `executeContextOp(op)` — dispatcher for above two
- `emitSnapshot(ws, trigger, requestId)` — uses `state.ipc`, `getJsonlPath()`, `state.SESSION_ID`

### `command-handler.ts` — Lines 1018-1840 of index.ts

This is the WebSocket `ws.on("message", ...)` handler body. Extract it as:

```typescript
export async function handleMessage(ws: WebSocket, msg: any): Promise<void> {
  // The big switch on msg.type
}
```

Each `if (msg.type === "...")` block becomes a call to a handler function:
- `handleMessageCmd(ws, msg)` — msg.type === "message"
- `handleCompact(ws, msg)` — msg.type === "compact"
- `handleSteer(ws, msg)` — msg.type === "steer"
- `handleForkAndSteer(ws, msg)` — msg.type === "fork_and_steer"
- `handleContext(ws, msg)` — msg.type === "context"
- `handleRewind(ws, msg)` — msg.type === "rewind"
- `handleSetOptions(ws, msg)` — msg.type === "set_options"
- `handlePermissionResponse(ws, msg)` — msg.type === "permission_response"
- `handleGetCommands(ws, msg)` — msg.type === "get_commands"
- `handleUtilityQuery(ws, msg)` — msg.type === "utility_query"
- `handleAdopt(ws, msg)` — msg.type === "adopt"
- `handleShutdown(ws, msg)` — msg.type === "shutdown"

These can be defined inline in command-handler.ts or as separate functions — whatever keeps it readable. The key is that `handleMessage` is the single entry point.

### `index.ts` — New entry point (~30 lines)

```typescript
import "./config.js";  // Side-effect: validates env, populates state
import { state } from "./state.js";
import { ORCHESTRATOR_URL } from "./config.js";
import { handleMessage } from "./command-handler.js";
import { logger } from "./logger.js";
import WebSocket from "ws";

function connect(): void {
  const ws = new WebSocket(ORCHESTRATOR_URL!);

  ws.on("open", async () => {
    logger.info("runner.ws", "connected", { session_id: state.SESSION_ID });
    // ... setup logic (lines 977-1015 of current index.ts)
  });

  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    await handleMessage(ws, msg);
  });

  ws.on("close", () => { ... reconnect ... });
  ws.on("error", (err) => { ... log ... });
}

logger.info("runner.start", "starting_runner", { session_id: state.SESSION_ID });
connect();
```

The `ws.on("open", ...)` handler (lines 977-1015) contains startup logic (vault sync, repo clone, warm session preload). This stays in index.ts since it's the main orchestration.

## Constraints

1. **No behavioral changes** — the compiled JS must produce identical behavior
2. **No new dependencies** — only reorganize existing code
3. **Preserve all log messages** — log scopes and messages must not change
4. **Preserve all WebSocket message formats** — wire protocol must not change
5. **Keep existing test contracts** — all 271 tests must pass unchanged
6. **Use `.js` extension in imports** — this is an ESM project (`"type": "module"` in package.json)

## Import graph

```
index.ts
  ├── config.ts (side-effect import)
  ├── state.ts
  ├── command-handler.ts
  │   ├── state.ts
  │   ├── config.ts
  │   ├── run-turn.ts
  │   │   ├── state.ts
  │   │   ├── session-lifecycle.ts
  │   │   ├── context-ops.ts
  │   │   ├── serialize.ts
  │   │   ├── background-drainer.ts
  │   │   └── merge-back.ts
  │   ├── source-prep.ts
  │   ├── session-lifecycle.ts
  │   └── context-ops.ts
  ├── source-prep.ts
  │   └── state.ts
  └── session-lifecycle.ts
      ├── state.ts
      └── config.ts
```

No circular dependencies. `state.ts` is a leaf (no imports from project files).

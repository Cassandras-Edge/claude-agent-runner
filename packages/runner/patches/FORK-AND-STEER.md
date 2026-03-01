# Fork-and-Steer: Responsive Agent Interrupts

## Problem

When the model is streaming (generating tokens — writing files, thinking, explaining,
spawning subagents), the user is blocked. They can't talk until the model finishes.
If the model is writing 500 lines of code or thinking for 30 seconds, the user waits.

Current options are bad:
- **Wait**: user sits idle while model finishes
- **Abort**: work is thrown away

## Solution: Fork-and-Steer

When the user submits a message while the model is streaming, the orchestrator
offers three modes:

| Mode | Behavior | Use case |
|------|----------|----------|
| `queue` | Wait for stream to finish, then deliver message | "I can wait" |
| `steer` | Abort stream, discard remaining output, deliver now | "Stop, do this instead" |
| `fork_and_steer` | Stream finishes in background, deliver message now | "Keep going but also answer me" |

Fork-and-steer preserves work AND keeps the conversation responsive.

## Architecture

```
                    ┌─────────────────────────┐
                    │      ORCHESTRATOR        │
                    │                          │
                    │  SDK: query() with       │
                    │  includePartialMessages  │
                    │                          │
                    │  Sees stream events:     │
                    │  content_block_start     │
                    │  input_json_delta        │
                    │  content_block_stop      │
                    │                          │
                    │  Has IPC to CLI via      │
                    │  memory-ipc socket       │
                    └────┬──────────┬──────────┘
                         │          │
                    CLI-A (bg)  CLI-B (fg)
                    finishes    handles user
                    stream      message
```

### Components involved

All existing — no new binary patches needed for the base case:

1. **Claude Agent SDK** — `includePartialMessages: true` gives streaming visibility
2. **memory-ipc patch** — `push`, `splice`, `emit` for context modification
3. **mcp-background patch** — task registry + TaskOutput for result tracking
4. **Orchestrator** — new routing logic (application code, not a patch)

### POSIX fork() (optional, Linux-only optimization)

For in-container deployments, `fork()` via Bun FFI gives near-instant process
cloning with COW memory. Proven working (see test-mcp-bg/test-fork.mjs).
Not required for the base implementation — orchestrator can spawn a new CLI
instance instead. Fork is a performance optimization.

## Flow: fork_and_steer

### Step 1: Detect streaming + user message

```
Orchestrator is iterating SDK stream (includePartialMessages: true)
User submits message with mode: "fork_and_steer"
```

### Step 2: Snapshot conversation state

```
Orchestrator reads current state from CLI via IPC:
  cmd: "get_messages" → full conversation history
  cmd: "session_id"   → current session ID
```

### Step 3: Fork

Two strategies (orchestrator chooses based on environment):

**Strategy A: New CLI instance (works everywhere)**
- Orchestrator spawns new CLI via SDK `query()`
- Passes snapshotted messages + synthetic tool_result + user's new message
- Original CLI continues streaming, finishes tool execution
- New CLI becomes foreground

**Strategy B: POSIX fork() (Linux/Docker only)**
- Orchestrator sends IPC command to CLI: `cmd: "fork"`
- CLI calls `fork()` via Bun FFI
- Child: keeps receiving stream, finishes tool execution, writes result to task file
- Parent: aborts stream, gets synthetic result, processes user message
- Parent becomes foreground

### Step 4: Background completes

```
Background CLI/child finishes the tool call
Writes result to task file: kq(taskId)
Orchestrator detects completion (poll task status or waitpid)
```

### Step 5: Merge back

```
Two outcomes only:

SUCCESS:
  Orchestrator IPC to foreground CLI:
    cmd: "splice"
    → replaces synthetic tool_result with real result
    → model sees correct history on next turn

FAILURE:
  Orchestrator IPC to foreground CLI:
    cmd: "push"
    → adds error message to conversation
    → model sees failure, can course-correct
```

## When to fork

The fork decision is based on what's streaming + whether the user interrupted:

```
User submits message while model is streaming?
    │
    NO → normal flow (queue the message for after streaming)
    │
    YES → what mode did the caller specify?
        │
        ├── queue          → buffer message, deliver after stream ends
        ├── steer          → abort stream, deliver now
        └── fork_and_steer → execute fork flow above
```

The caller (UI, API client, automation) chooses the mode explicitly.
The orchestrator does not guess.

## API contract

```
POST /sessions/:id/message
{
  "text": "where's the config file?",
  "mode": "fork_and_steer"   // or "queue" or "steer"
}

Response (when fork_and_steer):
{
  "status": "forked",
  "foreground_session": "new-session-id",
  "background_task": "task-id",
  "message": "Previous operation continuing in background"
}
```

## Context management

### What the foreground model sees after fork

```
[...history up to current turn,
 assistant: {tool_use: Write("/src/auth.ts"), content: "(forked to background)"},
 tool_result: "Background task <id>. Use TaskOutput when needed.",
 user: "where's the config file?"]
```

The model doesn't need the full file content echoed back — it already knows
what it was writing. The truncated tool_use is sufficient context.

### After merge-back (success)

```
[...history,
 assistant: {tool_use: Write("/src/auth.ts"), content: "(forked to background)"},
 tool_result: "File written successfully.",    ← spliced: real result
 user: "where's the config file?",
 assistant: "The config file is at...",
 ...]
```

History is coherent. The model made decisions assuming the write would succeed,
and it did. No inconsistency.

### After merge-back (failure)

```
[...history,
 ...,
 user: {system: "Background task failed: permission denied writing /src/auth.ts"},
 ...]
```

Pushed as a new message. Model sees it on next turn and can react.

## Foreground management

With multiple forks, one process has "foreground" (receives user input,
displays output). Others are background.

```
Orchestrator tracks:
  foreground: cli-session-abc (main agent, talking to user)
  background:
    task-001: Write("/src/auth.ts") → running
    task-002: Task("research auth") → running
    task-003: Task("write tests")   → completed ✓
```

User messages always route to foreground.
Background results splice into foreground via IPC.

## Read vs Write awareness

For the fork() optimization path (process-level fork), the orchestrator
uses tool annotations to decide if zone tracking is needed:

```
Read-only tools (fork freely, no coordination):
  Read, Glob, Grep, LSP, WebFetch, WebSearch, TaskOutput, TaskList, TaskGet

Write tools (need zone tracking for conflicts):
  Write, Edit, NotebookEdit, Bash

MCP tools:
  Check isReadOnly() annotation from server
```

For the simpler SDK-level fork-and-steer, zone tracking is not needed —
each background task runs to completion independently.

## Implementation phases

### Phase 1: Orchestrator routing (no patches)
- Add `mode` parameter to message submission API
- Implement `queue` (buffer) and `steer` (abort stream)
- These require no new patches — just orchestrator logic

### Phase 2: fork_and_steer via new CLI instance
- On fork_and_steer: snapshot state via IPC, spawn new CLI, merge back
- Uses existing patches: memory-ipc, mcp-background
- Pure orchestrator code in packages/orchestrator/

### Phase 3: fork_and_steer via POSIX fork() (Linux optimization)
- Add `fork` IPC command to memory-ipc patch
- Implement Bun FFI fork() in the CLI process
- Child inherits stream connection, finishes work
- Parent gets instant clone — no cold start, no reconnection
- Only for Docker/Linux deployments

### Phase 4: Parallel cognition
- Multiple concurrent forks (read-only tasks)
- Zone tracking for write conflicts
- Recursive fork trees with depth limits
- Process manager in orchestrator

## Dependencies

- [x] memory-ipc patch (exists)
- [x] mcp-background patch (exists — task registry, TaskOutput)
- [x] fork() proof of concept (exists — test-fork.mjs, verified on Bun/Linux)
- [x] SDK includePartialMessages (exists in @anthropic-ai/claude-agent-sdk)
- [ ] Orchestrator message routing (Phase 1)
- [ ] Orchestrator fork-and-steer logic (Phase 2)
- [ ] IPC fork command + Bun FFI (Phase 3)
- [ ] Zone tracking + process manager (Phase 4)

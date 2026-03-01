# mcp-background patch

Adds `run_in_background: true` support to all MCP tool calls, using the same
AppState.tasks + TaskOutput plumbing as Bash background commands.

## What it does

This patch chains a `.map()` after the MCP tool factory's `.map()` call (before `.filter()`).
For each MCP tool object, it:

1. **Schema injection**: Adds `run_in_background` (boolean) to `inputJSONSchema.properties`,
   so the model knows the option exists.

2. **Call wrapping**: Intercepts `.call()` when `run_in_background === true`:
   - Strips `run_in_background` from args (MCP server never sees it)
   - Creates a `local_bash`-type task in `AppState.tasks`
   - Fires the original MCP call as a detached async IIFE with a fresh `AbortController`
   - Returns immediately with the task ID
   - On completion: writes JSON result to the task's `.output` file
   - On error: writes error message to disk, marks task as failed

The model retrieves results via the existing `TaskOutput` tool — no changes needed there.

## Why `local_bash` type?

TaskOutput's `sVR()` function reads `local_bash` tasks from disk when no `shellCommand`
is present (falls back to `m8A(taskId)`). Our MCP background tasks have no `shellCommand`,
so they naturally use this disk-based fallback path.

## Global extractors

This patch uses `globalExtractors` (scan full 10MB JS) because the task management
functions are defined far from the MCP factory anchor:

| Variable | Function | Stable pattern |
|---|---|---|
| `TASK_ID_FN` | `wM` | `randomUUID()` call |
| `TASK_OBJ_FN` | `uL` | `{status:"pending",...outputOffset:0,notified:!1}` |
| `OUTPUT_PATH_FN` | `kq` | `` `${id}.output` `` template literal |
| `TASK_REGISTER_FN` | `MK` | `tasks:{...[id]:task}` spread |
| `TASK_UPDATE_FN` | `$q` | `tasks?.[id]` optional chain |
| `MKDIR_FN` | `c8A` | `mkdir({recursive:!0})` |

## Local extractors

Near the `originalMcpToolName` anchor:

| Variable | Purpose |
|---|---|
| `CONN_VAR` | Connection parameter in factory |
| `TOOL_VAR` | Map callback parameter |
| `GUARD_FN` | Conditional guard at end of .map() |
| `COMPAT_FN` | Compat function in ternary |
| `FILTER_FN` | Filter function after .map() |

## Updating for new CLI versions

After `claude update`, if this patch fails:

1. Extract the new cli.js: `bun run tools/extract-modules.js`
2. Global extractors: search for the stable patterns (e.g., `"task_started"`,
   `outputOffset:0`, `randomUUID()`) and verify the regex still captures
   the correct function name.
3. Local extractors: search for `originalMcpToolName` and verify the factory
   structure hasn't changed (`.map()` → `.filter()` chain).
4. insertAfter: verify the closing pattern of the `.map()` call is still
   `GUARD(CONN.name)?COMPAT(TOOL.name):{}}))`.

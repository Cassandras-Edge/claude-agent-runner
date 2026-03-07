# V2 Token Streaming Patch

## Problem

The V2 SDK's `unstable_v2_createSession()` hard-codes `includePartialMessages: false`
in the `SQ` constructor, ignoring whatever the caller passes in `SDKSessionOptions`.

The V1 `query()` API reads this option correctly from the `Options` type, but `SDKSessionOptions`
(the V2 type) doesn't even include `includePartialMessages` as a field.

This means V2 sessions never emit `SDKPartialAssistantMessage` (type `stream_event`) events,
which contain the `BetaRawMessageStreamEvent` deltas needed for token-level streaming.

## Root Cause

In `sdk.mjs`, the `SQ` class constructor:

```javascript
// Before patch (minified):
includePartialMessages:!1,forkSession:!1

// The options object is `Q` (SDKSessionOptions), but Q.includePartialMessages
// is never read — the value is hard-coded to false.
```

## Fix

```javascript
// After patch:
includePartialMessages:Q.includePartialMessages??!1,forkSession:!1
```

This reads `includePartialMessages` from the options if present, defaulting to `false`.

## Two Patches Required

### Patch 1: SDK (`sdk.mjs`)

`sed` in the Dockerfile after `npm ci`:

```dockerfile
RUN sed -i 's/includePartialMessages:!1,forkSession/includePartialMessages:Q.includePartialMessages??!1,forkSession/' \
    node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
```

### Patch 2: CLI (`cli-patched.js`)

The CLI enforces `--include-partial-messages requires --print and --output-format=stream-json`.
V2 interactive mode uses `--input-format stream-json --output-format stream-json` (not `--print`),
but the underlying `stream_event` yield code works fine in interactive mode:

```javascript
// In the message processing loop:
if(f) yield {type:"stream_event", event:C6.event, ...};
// `f` is includePartialMessages — works regardless of --print mode
```

Patch removes the `--print` requirement:

```dockerfile
RUN node -e "
  const fs = require('fs');
  let cli = fs.readFileSync('/opt/claude/cli-patched.js', 'utf8');
  cli = cli.replace(
    'if(T6){if(!s||h!==\"stream-json\")',
    'if(T6){if(h!==\"stream-json\")'
  );
  fs.writeFileSync('/opt/claude/cli-patched.js', cli);
"
```

## SDK Version

Verified against `@anthropic-ai/claude-agent-sdk@0.2.63` and `@anthropic-ai/claude-code@2.1.63`.

## Impact

When the runner passes `includePartialMessages: true` in session options,
V2 sessions now emit `stream_event` events containing:
- `content_block_start` (tool_use, thinking block starts)
- `content_block_delta` (text_delta, thinking_delta, input_json_delta)
- `content_block_stop`
- `message_start`, `message_delta`, `message_stop`

These flow through the runner → orchestrator → WS → Cassandra client,
enabling token-by-token streaming in the UI.

## Status

These patches are currently **inline in the Dockerfile** (not in the patch system).
This means `cli-version-check.yml` does NOT test them during dry-runs.
They should be migrated to the patch system for automated validation.

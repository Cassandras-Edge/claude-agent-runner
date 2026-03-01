# no-sibling-abort patch

Removes the "sibling tool call errored" abort behavior.

## Problem

When multiple tool calls run in parallel and one fails, Claude Code aborts
all remaining sibling tool calls with:

```
<tool_use_error>Sibling tool call errored</tool_use_error>
```

This throws away valid results from tools that already completed or were
about to complete. The model asked for these tools in parallel because
they're independent — it can handle partial results.

## Fix

Remove the `sibling_error` check from `getAbortReason()` in the tool
executor (`zpT` class). Each tool call succeeds or fails independently.
The model sees all results (including any errors) and decides what to do.

## What changed

```js
// Before:
getAbortReason(T) {
  if (this.discarded) return "streaming_fallback";
  if (this.hasErrored && !this.allToolsAreWriteOrEdit()) return "sibling_error"; // ← kills siblings
  // ...
}

// After:
getAbortReason(T) {
  if (this.discarded) return "streaming_fallback";
  // sibling_error removed — each tool completes independently
  // ...
}
```

## Updating for new CLI versions

Search for `sibling_error` in the extracted JS. If the string is still
there, the patch should work. If the logic moved or changed, find the
new `getAbortReason` method and update the `find` string.

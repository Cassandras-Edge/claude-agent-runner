# Subagent classifyHandoffIfNeeded Fix

## Problem

Every Task tool subagent (background agent) crashes on completion with:

```
ReferenceError: classifyHandoffIfNeeded is not defined
```

The function is **called but never defined** in the bundled `cli.js`. It was likely added as a call site during development but the function definition was either:
- Not included in the production bundle
- Renamed/removed during refactoring without updating the call site

The error occurs **after** all agent work completes successfully, so results are intact but the agent reports "failed" status instead of "completed".

## Impact

- All Task tool subagents report `failed` status despite completing work
- `SubagentManager` and orchestration tools see false failures
- Retry logic may trigger unnecessarily
- Affects Claude Code v2.1.27 through v2.1.42 (and likely newer until fixed upstream)

## Upstream Tracking

Multiple open GitHub issues:
- [#24181](https://github.com/anthropics/claude-code/issues/24181) - Task tool agents always report "failed"
- [#22087](https://github.com/anthropics/claude-code/issues/22087) - SubagentStop hook failure
- [#22312](https://github.com/anthropics/claude-code/issues/22312) - Task tool subagent fails
- [#22544](https://github.com/anthropics/claude-code/issues/22544) - ReferenceError on completion
- [#22573](https://github.com/anthropics/claude-code/issues/22573) - Research subagents fail on completion

## Binary Analysis

**Location:** Inside the subagent execution function, at the completion path after `IwA()` aggregates results.

**Call site (line ~2277 of cli-clean.js, byte offset ~7544884):**

```js
// Context: after subagent finishes all turns
let NT = IwA(IT, jT, v),
    VT = NT.content.filter((XR) => XR.type === "text").map((XR) => XR.text).join(`\n`),
    TR = await G.getAppState(),
    ZR = await classifyHandoffIfNeeded({      // <-- THIS CRASHES
      agentMessages: IT,
      toolPermissionContext: TR.toolPermissionContext,
      abortSignal: QT.abortController.signal,
      isNonInteractiveSession: G.options.isNonInteractiveSession,
      subagentType: R,
      totalToolUseCount: NT.totalToolUseCount
    });
if (ZR) VT = `${ZR}\n\n${VT}`;               // Prepends handoff classification to result
DKA(NT, G.setAppState),
gDT(jT, A, "completed", void 0, ...);         // <-- NEVER REACHED
```

**Occurrences in binary:** 1 call site, 0 definitions (in clean cli.js copy — Module [5])

**What `classifyHandoffIfNeeded` was supposed to do:** Based on its arguments, it appears to classify whether the subagent's result should include a "handoff" summary (prepended to the result text). When the function returns null/undefined, the result is used as-is. This is a non-critical enrichment step — skipping it has no effect on correctness.

## Patch

**Search string (appears 2x in binary — both copies of cli.js):**

```
ZR=await classifyHandoffIfNeeded({agentMessages:IT,toolPermissionContext:TR.toolPermissionContext,abortSignal:QT.abortController.signal,isNonInteractiveSession:G.options.isNonInteractiveSession,subagentType:R,totalToolUseCount:NT.totalToolUseCount})
```

**Replacement (shorter, space-padded to same length):**

```
ZR=await (async()=>null)()
```

**Effect:** `ZR` is always `null`, so the `if(ZR)` branch is skipped and the agent completes normally via `gDT(jT, A, "completed", ...)`. No functional change — just removes the crash.

## Usage

```bash
bun run patches/subagent-classifyHandoff-fix/patch.js           # apply
bun run patches/subagent-classifyHandoff-fix/patch.js --restore  # revert
```

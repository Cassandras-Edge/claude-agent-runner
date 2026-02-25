# /clear and /resume in stream-json mode

## Problem

Claude Code's `/clear` and `/resume` are TUI-only React UI actions — they don't work in `--output-format stream-json` mode (used by the SDK). SDK consumers can't programmatically clear or switch context mid-session.

Without this patch, the only way to clear context is to kill and respawn the subprocess (~7s). Resuming a different session requires a new subprocess (~4s).

## What It Does

Intercepts `/clear` and `/resume <id>` as user messages in the stream-json main loop, operating directly on the in-memory `mutableMessages` array:

- **`/clear`**: Empties `mutableMessages` in-place → 0.001s (vs ~7s respawn)
- **`/resume <id>`**: Loads target session's JSONL into `mutableMessages` → 0.002s (vs ~4s respawn)

No subprocess restart needed. The agent keeps its process, just swaps context.

## Patch Type: Template

This patch uses the **template** system (`type: "template"` in spec.json) because it injects new code that references local variables whose minified names change every CLI build. Instead of hardcoding variable names, the patch:

1. Finds a **stable anchor string** in the JS source
2. Runs **regex extractors** against nearby code to derive current variable names
3. **Interpolates** a template with the resolved names
4. **Inserts** the generated code at the right location

## How the Template Works

### spec.json

```json
{
  "id": "clear-resume",
  "type": "template",
  "target": "js-only",
  "anchor": "only prompt commands are supported in streaming mode",
  "extractors": {
    "CMD_VAR":      "while\\((\\w+)=await \\w+\\(",
    "PROMPT_VAR":   "let (\\w+)={{CMD_VAR}}\\.value;",
    "MESSAGES_VAR": "mutableMessages:(\\w+),",
    "QUEUE_VAR":    "(\\w+)\\.enqueue\\(\\{type:\"system\"",
    "SESSION_FN":   "session_id:(\\w+)\\(\\)",
    "UUID_MOD":     "uuid:(\\w+)\\.randomUUID\\(\\)",
    "LOADER_FN":    "let \\w+=await (\\w+)\\(\\w+\\.sessionId,\\w+\\.jsonlFile"
  },
  "codeFile": "patch-code.js.tmpl",
  "insertAfter": "let {{PROMPT_VAR}}={{CMD_VAR}}.value;"
}
```

### Anchor

`"only prompt commands are supported in streaming mode"` — a unique error message string (1 occurrence in the entire JS) that sits inside the stream-json command dequeue loop. This is the structural landmark that locates the patch site.

### Extractors

Extractors run in order. Each produces one variable name via a regex capture group. Later extractors can reference earlier results with `{{VAR}}`.

| Name | What it finds | Pattern logic | v2.1.42 result |
|------|--------------|---------------|----------------|
| `CMD_VAR` | Command variable from stdin dequeue | `while(X=await dequeueFunc(` → capture X | `r` |
| `PROMPT_VAR` | User prompt content (string or ContentBlock[]) | `let Y=CMD_VAR.value;` → capture Y | `HT` |
| `MESSAGES_VAR` | The mutableMessages array | `mutableMessages:Z,` → capture Z | `I` |
| `QUEUE_VAR` | Output queue to SDK (enqueue results) | `W.enqueue({type:"system"` → capture W | `E` |
| `SESSION_FN` | Function returning current session ID | `session_id:F()` → capture F | `kR` |
| `UUID_MOD` | Crypto module for UUID generation | `uuid:M.randomUUID()` → capture M | `MK` |
| `LOADER_FN` | Session JSONL loader function | `let X=await L(_.sessionId,_.jsonlFile` → capture L | `Te` |

### Template (patch-code.js.tmpl)

The template uses `{{PLACEHOLDER}}` syntax. For example:
```js
if(_ct&&_ct.trim()==="/clear"){
  {{MESSAGES_VAR}}.length=0;
  {{QUEUE_VAR}}.enqueue({type:"result",...,session_id:{{SESSION_FN}}(),uuid:{{UUID_MOD}}.randomUUID(),...});
  continue
}
```

After resolution with v2.1.42 names, this becomes:
```js
if(_ct&&_ct.trim()==="/clear"){
  I.length=0;
  E.enqueue({type:"result",...,session_id:kR(),uuid:MK.randomUUID(),...});
  continue
}
```

### Insertion Point

`insertAfter: "let {{PROMPT_VAR}}={{CMD_VAR}}.value;"` resolves to `"let HT=r.value;"` — this is the line where the user's message content is extracted from the dequeued command, right before it's passed to the LLM query function. The patch intercepts `/clear` and `/resume` messages here and short-circuits with a result, skipping the LLM call.

## Code Structure at the Patch Site

The relevant code path (deobfuscated, v2.1.42):

```
cS8()                           # stream-json mode handler
  └─ kT()                       # async function that processes commands
      └─ TT()                   # inner loop
          └─ while(r = await mXR(H,q))   # dequeue next command from stdin
              ├─ if task-notification → handle + continue
              ├─ let HT = r.value;        # ← PROMPT CONTENT
              ├─ *** PATCH INSERTS HERE ***
              │   /clear  → I.length=0, enqueue result, continue
              │   /resume → Te(id), push messages, enqueue result, continue
              └─ for await(KT of b00({prompt:HT,...}))  # normal LLM query
```

## Use Case: RLM Context Filter

When sessions accumulate thousands of messages, the agent can programmatically:
1. Search its session JSONL for relevant messages
2. Create a filtered JSONL with only selected messages
3. `/clear` + `/resume <filtered-id>` to load the filtered context
4. Work with focused context
5. `/clear` + `/resume <original-id>` to restore full context

This enables smart compaction — instead of losing information to blind SDK compaction, the agent selectively keeps what matters.

## Updating for New CLI Versions

When `bun run scripts/patch-all.js` skips this patch after a `claude update`:

### If the anchor string changed

The error message `"only prompt commands are supported in streaming mode"` is checked inside the command dequeue loop. If it changed:
1. Extract the new cli.js: `bun run scripts/patch-all.js` (extraction still works even if patches fail)
2. Search for the stream-json dequeue loop — look for `while(` + `await` + `queuedCommands` nearby
3. Find the new error message and update `anchor` in spec.json

### If an extractor broke

The extractor's regex didn't match in the region around the anchor. To fix:

1. Look at the error output — it tells you which extractor failed
2. Extract the cli.js and search near the anchor for the equivalent structural pattern
3. Update the regex in `spec.json`'s extractors

**Tips for writing extractors:**
- Use **property names** as anchors — `mutableMessages:`, `session_id:`, `uuid:` are stable
- Use **structural patterns** — `while(X=await`, `let X=Y.value;`, `.enqueue({type:`
- Capture the **first group** `(\w+)` — this becomes the variable name
- Extractors run in order — reference earlier results with `{{EARLIER_VAR}}`
- Test with `--dry-run` to see resolved names without writing files

### If the code structure changed

If the stream-json handler was significantly refactored (e.g., the command loop was moved into a class method), the patch logic may need adapting. The template code (`patch-code.js.tmpl`) and the spec's `insertAfter` would need updating. The key invariant is: we need to intercept user messages **after** they're dequeued and **before** they're passed to the LLM query function.

## Important Findings

### Prompt content is a ContentBlock array

The prompt variable (e.g. `HT` in v2.1.42) is `message.content` from the SDK — either a plain string or `[{type:"text",text:"..."}]`. The patch handles both:
```js
let _ct = typeof HT==="string" ? HT :
  Array.isArray(HT) ? HT.filter(b=>b.type==="text").map(b=>b.text).join("") : null;
```

### Session JSONL paths

The session loader resolves JSONL paths using the CLI's internal CWD function. The project dir is `~/.claude/projects/{encoded-cwd}/`.

**Critical**: V2 `createSession` stores JSONLs based on the **actual `process.cwd()`** of the node process, NOT the `cwd` option passed to the SDK.

### Minimal JSONL works

A filtered JSONL with just `user` + `assistant` entries (no `queue-operation`, no `result`) loads successfully.

### V2 SDK required

V1 `query()` closes stdin after the first result. V2 `createSession` is needed for persistent `/clear` + `/resume`.

## Performance

| Operation | Patched CLI | Subprocess Respawn |
|-----------|-------------|-------------------|
| /clear | 0.001s | ~7s |
| /resume | 0.002s | ~4s |
| Baseline follow-up | 1.3s | 1.3s |

## Variable History

Names change every build. The template system handles this automatically, but for reference:

| Purpose | Old build | v2.1.42 |
|---------|-----------|---------|
| Prompt content | `w1` | `HT` |
| mutableMessages | `V` | `I` |
| Output queue | `W` | `E` |
| Session loader | `We` | `Te` |
| Session ID fn | `g6` | `kR` |
| UUID generator | `rN` | `MK.randomUUID` |
| Command dequeue loop var | `a` | `r` |
| Stream-json handler fn | `T0z` | `cS8` (now `cS8` → `kT` → `TT` nested) |

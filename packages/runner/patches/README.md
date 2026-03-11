# Claude Code Binary Patches

Tools and patches for modifying Claude Code's embedded JavaScript.

## Quick Start

```bash
# Apply all patches against system binary
bun run scripts/patch-all.js --js-only

# Apply against a snapshot (recommended for dev)
bun run scripts/patch-all.js --binary snapshots/cli-2.1.63.js --js-only

# Preview without writing
bun run scripts/patch-all.js --binary snapshots/cli-2.1.63.js --js-only --dry-run

# Apply + replace system binary
bun run scripts/patch-all.js --install

# Restore original binary
bun run scripts/patch-all.js --restore
```

After `claude update`, re-run `bun run scripts/patch-all.js`.

## Patches

| Patch | Type | Target | Description |
|-------|------|--------|-------------|
| `webfetch-skip-haiku` | replacement | both | Skip Haiku summarization in WebFetch (**disabled**) |
| `clear-resume` | template | js-only | `/clear` and `/resume` in stream-json (SDK) mode |
| `memory-ipc` | template | js-only | Unix socket IPC for live context surgery |
| `mcp-background` | template | js-only | `run_in_background` for all MCP tool calls |
| `compact-instructions` | template | js-only | Inject custom compaction prompts from `RUNNER_COMPACT_INSTRUCTIONS` env |

**Target:**
- `both` — applied to the binary (CLI) and extracted JS (SDK)
- `js-only` — applied only to extracted JS (insertions can't go in the binary)

## Outputs

After running `patch-all.js`, the `dist/` directory contains:

| File | Purpose |
|------|---------|
| `cli-patched.js` | Patched JS for SDK usage via `pathToClaudeCodeExecutable` |
| `claude-patched` | Patched binary for CLI usage |
| `metadata.json` | Version, applied patches, checksums, resolved template vars |

## Structure

```
patches/
├── scripts/
│   └── patch-all.js               # Unified entry point
├── lib/
│   └── patcher.js                 # Shared extraction + patching logic
├── patches/
│   ├── webfetch-skip-haiku/       # Disabled replacement patch
│   ├── clear-resume/              # /clear and /resume in SDK mode
│   ├── memory-ipc/                # Unix socket IPC server
│   └── mcp-background/            # Background MCP tool execution
├── snapshots/                     # Gitignored binary + extracted JS
├── tools/                         # Exploration utilities
├── test-mcp-bg/                   # Integration tests
├── dist/                          # Gitignored outputs
└── README.md
```

## How It Works

Claude Code is a Bun-compiled binary with JavaScript embedded in a virtual filesystem (`$bunfs`). The JS source is stored as plain text, enabling three patching approaches:

### 1. Replacement patches (`type: "replacement"`)

Same-length string substitutions. Work on both the binary and extracted JS. Simple but fragile — if the minified code changes, the find string won't match.

```json
{
  "id": "my-patch",
  "type": "replacement",
  "find": "original code expression",
  "replace": "new code (shorter or equal length)",
  "target": "both"
}
```

### 2. Insertion patches (`type: "insertion"`)

Inject new code after a marker string. JS-only (can't change binary length). The marker must match exactly.

```json
{
  "id": "my-patch",
  "type": "insertion",
  "insertAfter": "marker string",
  "codeFile": "patch-code.js",
  "target": "js-only"
}
```

### 3. Template patches (`type: "template"`)

**Version-resilient insertion patches.** Instead of hardcoding minified variable names (which change every build), templates use regex extractors to derive them at apply-time from stable structural patterns.

```json
{
  "id": "my-patch",
  "type": "template",
  "anchor": "unique stable string to locate the right code region",
  "globalExtractors": {
    "FAR_VAR": "regex to find functions anywhere in the 10MB JS"
  },
  "extractors": {
    "NEAR_VAR": "regex to find variables within 30KB of anchor"
  },
  "codeFile": "patch-code.js.tmpl",
  "insertAfter": "let {{NEAR_VAR}}=something;",
  "target": "js-only"
}
```

The patch code template uses `{{MY_VAR}}` placeholders that get replaced with the derived names.

**Extractors:**
- `extractors` — scan a 30KB region around the anchor (5KB before, 25KB after)
- `globalExtractors` — scan the full JS content (for functions defined far from the anchor)
- Both are ordered, chainable (`{{VAR}}` references to earlier extractors), and must have exactly one capture group

**Pipeline:** Extract cli.js from binary → Run global extractors → Run local extractors → Interpolate template + insertAfter → Insert code → Output patched JS.

## Snapshots

Keep a stable binary snapshot for development instead of patching the system binary:

```bash
# Create snapshot (one-time)
cp ~/.local/share/claude/versions/2.1.63 snapshots/cli-2.1.63.js

# Extract JS for analysis
node -e "const {extractJS}=await import('./lib/patcher.js'); \
  require('fs').writeFileSync('snapshots/cli-2.1.63.js', extractJS('snapshots/cli-2.1.63.js'))"

# Patch against snapshot
bun run scripts/patch-all.js --binary snapshots/cli-2.1.63.js --js-only
```

## After `claude update`

1. Run `bun run scripts/patch-all.js`
2. If all patches apply: done
3. If a patch is skipped (pattern not found):
   - The minified code changed in the new version
   - For **replacement** patches: extract the new cli.js, find the equivalent expression, update `find`/`replace` in `spec.json`
   - For **template** patches: the extractors or anchor may need updating — see the "Updating Extractors" section in each patch's README

## What's Stable vs What Changes

When reverse-engineering a new CLI version, these patterns help:

**Stable across builds** (safe to use as anchors/extractors):
- Error message strings: `"only prompt commands are supported in streaming mode"`
- Property names in object literals: `mutableMessages:`, `session_id:`, `originalMcpToolName:`
- String literals: `"stream-json"`, `"task_started"`, `"pending"`
- Method names on stable APIs: `.enqueue(`, `.randomUUID()`, `.push(`
- Structural patterns: `outputOffset:0,notified:!1`, `tasks?.[`

**Changes every build** (must be derived, not hardcoded):
- Local variable names: `r`, `HT`, `I`, `E`, `kR`, `MK`, `Te`
- Function names: `mXR`, `b00`, `P00`, `cS8`
- Class names: `P00`, `amT`

## Adding New Patches

1. Create `patches/<name>/` with a `spec.json` (see types above)
2. For insertion/template patches, add the code file (`.js.tmpl` for templates)
3. Add a `README.md` documenting the problem, approach, and how to update
4. Run `bun run scripts/patch-all.js --dry-run` to verify

## Exploration Tools

```bash
bun run tools/extract-modules.js    # dump all modules to /tmp/claude/claude-extracted/
bun run tools/strip-prefix.js       # clean the extracted cli.js
bun run tools/probe-binary.js       # analyze binary trailer/metadata
```

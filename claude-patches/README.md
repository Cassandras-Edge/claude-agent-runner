# Claude Code Binary Patches

Tools and patches for modifying Claude Code's embedded JavaScript.

## Quick Start

```bash
# Apply all patches — produces dist/cli-patched.js + dist/claude-patched
bun run scripts/patch-all.js

# Preview without writing
bun run scripts/patch-all.js --dry-run

# Apply + replace system binary
bun run scripts/patch-all.js --install

# Restore original binary
bun run scripts/patch-all.js --restore
```

After `claude update`, re-run `bun run scripts/patch-all.js`.

## Patches

| Patch | Type | Target | Description |
|-------|------|--------|-------------|
| `webfetch-skip-haiku` | replacement | both | Skip Haiku summarization in WebFetch |
| `subagent-classifyHandoff-fix` | replacement | both | Fix undefined `classifyHandoffIfNeeded` crash |
| `clear-resume` | template | js-only | `/clear` and `/resume` in stream-json (SDK) mode |

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
claude-patches/
├── scripts/
│   └── patch-all.js               # Unified entry point
├── lib/
│   └── patcher.js                 # Shared extraction + patching logic
├── patches/
│   ├── webfetch-skip-haiku/
│   │   ├── spec.json              # Patch definition (replacement)
│   │   ├── patch.js               # Legacy standalone script
│   │   └── README.md
│   ├── subagent-classifyHandoff-fix/
│   │   ├── spec.json              # Patch definition (replacement)
│   │   ├── patch.js               # Legacy standalone script
│   │   └── README.md
│   └── clear-resume/
│       ├── spec.json              # Patch definition (template)
│       ├── patch-code.js.tmpl     # Template with {{VAR}} placeholders
│       ├── patch-code.js          # Legacy hardcoded version (reference)
│       └── README.md
├── tools/                         # Exploration utilities
│   ├── extract-modules.js         # Extract all embedded modules from Bun binary
│   ├── strip-prefix.js            # Strip binary prefix from extracted JS
│   ├── probe-binary.js            # Analyze Bun binary trailer/metadata
│   └── patch.js                   # Generic binary patcher (legacy)
├── dist/                          # Gitignored outputs
└── README.md
```

## How It Works

Claude Code is a Bun-compiled Mach-O binary with JavaScript embedded in a virtual filesystem (`$bunfs`). The JS source is stored as plain text, enabling three patching approaches:

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
  "extractors": {
    "MY_VAR": "regex with (capture group) to extract variable name"
  },
  "codeFile": "patch-code.js.tmpl",
  "insertAfter": "let {{MY_VAR}}=something;",
  "target": "js-only"
}
```

The patch code template uses `{{MY_VAR}}` placeholders that get replaced with the derived names. See [clear-resume/README.md](patches/clear-resume/README.md) for a detailed example.

**Pipeline:** Extract cli.js from binary → Run extractors to resolve variable names → Interpolate template → Insert code → Output patched JS + patched binary.

## After `claude update`

1. Run `bun run scripts/patch-all.js`
2. If all patches apply: done
3. If a patch is skipped (pattern not found):
   - The minified code changed in the new version
   - For **replacement** patches: extract the new cli.js, find the equivalent expression, update `find`/`replace` in `spec.json`
   - For **template** patches: the extractors or anchor may need updating — see the "Updating Extractors" section in the patch's README

## What's Stable vs What Changes

When reverse-engineering a new CLI version, these patterns help:

**Stable across builds** (safe to use as anchors/extractors):
- Error message strings: `"only prompt commands are supported in streaming mode"`
- Property names in object literals: `mutableMessages:`, `session_id:`, `queuedCommands:`
- String literals: `"stream-json"`, `"result"`, `"success"`
- Method names on stable APIs: `.enqueue(`, `.randomUUID()`, `.push(`

**Changes every build** (must be derived, not hardcoded):
- Local variable names: `r`, `HT`, `I`, `E`, `kR`, `MK`, `Te`
- Function names: `mXR`, `b00`, `P00`, `cS8`
- Class names: `P00`, `amT`

## Adding New Patches

1. Create `patches/<name>/` with a `spec.json` (see types above)
2. For insertion/template patches, add the code file
3. Add a `README.md` documenting the problem, approach, and how to update for new versions
4. Run `bun run scripts/patch-all.js`

## Binary Layout (v2.1.42)

The binary contains 17 embedded modules. The main code lives in two copies of `cli.js`:
- Module [0]: bytecode-annotated (37 MB)
- Module [5]: readable source (10 MB)

Both contain the same JS source. Replacement patches target both occurrences.

## Exploration Tools

```bash
bun run tools/extract-modules.js    # dump all modules to /tmp/claude/claude-extracted/
bun run tools/strip-prefix.js       # clean the extracted cli.js
bun run tools/probe-binary.js       # analyze binary trailer/metadata
```

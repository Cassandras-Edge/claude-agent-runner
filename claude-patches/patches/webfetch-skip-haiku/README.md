# Claude Code WebFetch Patch Guide

## Problem

Claude Code's `WebFetch` tool is slow and lossy:

1. **Fetches URL** via Axios (~1-2s)
2. **Converts HTML→Markdown** with Turndown client-side (~100ms)
3. **Sends to Haiku** for summarization (~3-8s, truncates to 100K chars, loses content)

Step 3 is the bottleneck. It adds latency and discards content the model deems irrelevant.

## Binary Structure

Claude Code (v2.1.42) is a Bun-compiled Mach-O binary at:
```
~/.local/share/claude/versions/<version>
```

It embeds 17 modules in Bun's `$bunfs` virtual filesystem. The main code is in two copies of `cli.js`:
- Module [0] @ offset ~59.6M: bytecode-annotated copy (37 MB)
- Module [5] @ offset ~155.6M: readable source copy (10 MB)

Both contain identical JS source text. Patches must target **both occurrences**.

## Architecture of WebFetch

### Key Functions (minified names)

| Function | Purpose |
|----------|---------|
| `fW` | The WebFetch tool object (name, call, permissions, etc.) |
| `vfB(T, R)` | Fetches URL, converts HTML with Turndown, caches result |
| `ufB(T, R, A, _, B)` | Sends markdown + prompt to Haiku for summarization |
| `xfB(T, R, A)` | Raw Axios GET with redirect handling |
| `SfB(T)` | Checks if URL is a known docs site (skip Haiku if so) |
| `LG8(T)` | Preflight domain safety check via `api.anthropic.com` |
| `yfB` | TurndownService constructor |
| `MfB` | LRU cache (15min TTL, 50MB max) |
| `lzR` | Content truncation limit (100K chars) |

### Constants

```
JG8 = 900000     # Cache TTL: 15 minutes (ms)
CG8 = 52428800   # Cache max size: 50 MB
WG8 = 2000       # Max URL length
QG8 = 10485760   # Max response size: 10 MB
XG8 = 60000      # Request timeout: 60 seconds
hG8 = 10000      # Preflight check timeout: 10 seconds
lzR = 100000     # Content truncation: 100K chars
```

### Flow

```
call({url, prompt}) →
  vfB(url, abortController) →
    check MfB cache →
    LG8(hostname) preflight check →
    xfB(url, signal) Axios GET →
    if text/html: new yfB().turndown(html) →
    cache in MfB →
    return {content, code, bytes, contentType}

  SfB(url) → is known docs site?
  if (knownSite && text/markdown && content < 100K):
    return content directly (skip Haiku)
  else:
    ufB(prompt, content, signal) →
      truncate to 100K chars →
      call Haiku via vG() with querySource:"web_fetch_apply" →
      return model response
```

## Patch Targets

### Patch 1: Skip Haiku Summarization

**Location:** Inside `fW.call()` — the WebFetch tool's main handler

**Search string (appears 2x in binary):**
```
else C=await ufB(R,$,A.signal,_,J)
```

**Context:**
```js
let{content:$,bytes:H,code:q,codeText:O,contentType:G}=D,J=SfB(T),C;
if(J&&G.includes("text/markdown")&&$.length<lzR)C=$;
else C=await ufB(R,$,A.signal,_,J);
//    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ THIS IS THE HAIKU CALL
```

**Replacement (same length, pad with spaces):**
```
else C=$
```

**Effect:** Always returns raw markdown. Eliminates 3-8s Haiku latency and content loss.

---

### Patch 2: Replace Turndown with Cloudflare API

**Location:** Inside `vfB()` — the fetch function

**Search string (appears 2x in binary):**
```
if(H.includes("text/html"))O=new yfB().turndown($);else O=$
```

**Context:**
```js
let $=Buffer.from(D.data).toString("utf-8"),
    H=D.headers["content-type"]??"",
    q=Buffer.byteLength($),O;
if(H.includes("text/html"))O=new yfB().turndown($);else O=$;
//                           ^^^^^^^^^^^^^^^^^^^^^^^^ TURNDOWN
return MfB.set(T,{bytes:q,code:D.status,codeText:D.statusText,content:O,contentType:H}),
       {code:D.status,codeText:D.statusText,content:O,contentType:H,bytes:q}
```

**Note:** This replacement is LONGER than the original (Cloudflare API URL + headers + fetch call). For binary patching, you'd need to either:
- Replace the `ufB` function body (now dead code after Patch 1) with a Cloudflare helper, and call it from here
- Or inject code into null-padded regions of the binary

**Alternative simpler patch:** Just keep Turndown (it's fast, ~100ms) and only apply Patch 1. Turndown + no Haiku is already a huge improvement.

---

### Patch 3 (Optional): Increase Content Limit

**Search string:**
```
lzR=1e5
```

**Replacement:**
```
lzR=5e5
```

**Effect:** Raises truncation from 100K to 500K chars. Only matters if Haiku is still enabled (Patch 1 not applied). Same byte length.

---

### Patch 4 (Optional): Increase maxResultSizeChars

**Search string:**
```
name:xO,maxResultSizeChars:1e5
```

**Replacement:**
```
name:xO,maxResultSizeChars:5e5
```

**Effect:** Allows up to 500K chars in the tool result returned to Claude. Useful after Patch 1 since raw markdown can be large. Same byte length.

## Patch Script

See `/tmp/claude/patch-binary.js` — a reusable Bun script that:
1. Finds the Claude binary via `which claude`
2. Backs up to `<binary>.orig`
3. Applies same-length string replacements across all occurrences
4. Re-codesigns (ad-hoc) for macOS
5. Verifies with `claude --version`
6. Supports `--restore` flag to revert

## Extraction Tools

| File | Purpose |
|------|---------|
| `/tmp/claude/extract_v2.js` | Extracts all embedded modules from the Bun binary |
| `/tmp/claude/strip_cli.js` | Strips binary prefix from extracted cli.js |
| `/tmp/claude/probe_structure.js` | Analyzes Bun binary trailer/metadata structure |

## Known Docs Sites (preapproved, skip Haiku already)

The `SfB` function checks URLs against `pzR`, a hardcoded list including:
- docs.python.org, developer.mozilla.org, nodejs.org/api
- git-scm.com, nginx.org, httpd.apache.org
- (and others)

These already skip Haiku when they serve `text/markdown` and content < 100K chars.

## Related: Cloudflare Markdown for Agents

Cloudflare's edge network can convert HTML→Markdown server-side:
- **Content negotiation:** `Accept: text/markdown` header (Claude Code already sends this!)
- **Browser Rendering API:** `POST /browser-rendering/markdown` with `{url}` body
- **markdown.new:** Prepend `markdown.new/` to any URL for instant conversion
- 3-tier fallback: content negotiation → Workers AI → headless browser rendering

If a Cloudflare-enabled site has Markdown for Agents active, WebFetch already receives markdown and skips Turndown. But it still runs Haiku unless Patch 1 is applied.

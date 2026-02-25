/**
 * Shared patching library for Claude Code binary modifications.
 *
 * Claude Code is a Bun-compiled Mach-O binary with JS embedded in a $bunfs
 * virtual filesystem. The readable cli.js source (~10MB) can be extracted,
 * modified, and either repacked into the binary (same-length replacements)
 * or used standalone (for SDK via pathToClaudeCodeExecutable).
 */

import { readFileSync, existsSync, copyFileSync, chmodSync } from "fs";
import { execSync } from "child_process";
import { createHash } from "crypto";

// ── Binary discovery ──────────────────────────────────────────────────────

/** Resolve the actual claude binary path (follows symlinks). */
export function findBinary() {
  const raw = execSync("which claude", { encoding: "utf-8" }).trim();
  try {
    return execSync(`readlink -f ${raw} 2>/dev/null`, { encoding: "utf-8" }).trim();
  } catch {
    return raw;
  }
}

/** Get Claude Code version string from the binary. */
export function getVersion(binaryPath) {
  return execSync(`${binaryPath} --version 2>&1`, {
    encoding: "utf-8",
    timeout: 10000,
  }).trim();
}

// ── JS extraction ─────────────────────────────────────────────────────────

/**
 * Extract the readable cli.js source from the binary.
 *
 * The binary has two copies of cli.js embedded in $bunfs. Each starts with
 * a "// @bun" comment. We find all such JS content blocks, measure their
 * size, and return the ~10MB readable source (not the ~37MB bytecode copy).
 *
 * Layout around each cli.js:
 *   /$bunfs/root/src/entrypoints/cli.js\0  (path)
 *   /$bunfs/root/claude\0                  (secondary path)
 *   // @bun @bytecode @bun-cjs\n           (JS content starts here)
 *   (function(exports, ...                 (the actual code)
 */
export function extractJS(binaryPath) {
  const buf = readFileSync(binaryPath);
  const cliPath = "/$bunfs/root/src/entrypoints/cli.js";

  // Find all cli.js path occurrences
  const candidates = [];
  let searchFrom = Math.floor(buf.length * 0.3);
  while (true) {
    const idx = buf.indexOf(cliPath, searchFrom);
    if (idx === -1) break;

    // Find "// @bun" within 200 bytes of the path — this is where JS starts
    const scanRegion = buf.subarray(idx, idx + 200);
    const jsMarkerOffset = scanRegion.indexOf("// @bun");
    if (jsMarkerOffset !== -1) {
      const jsStart = idx + jsMarkerOffset;

      // Find content end: scan forward for the next $bunfs module path that's
      // far enough away (>1MB) to be a different module, not a sub-path
      let jsEnd;
      let scanPos = jsStart + 1024 * 1024; // skip at least 1MB
      while (true) {
        const nextBunfs = buf.indexOf("/$bunfs/root/", scanPos);
        if (nextBunfs === -1) {
          // Last module — use trailer
          const trailer = buf.lastIndexOf("---- Bun! ----");
          jsEnd = trailer;
          break;
        }
        // Check it's a real module boundary (not just a string in the JS)
        // Real module paths are preceded by null bytes
        if (buf[nextBunfs - 1] === 0) {
          // Back up past trailing nulls
          jsEnd = nextBunfs - 1;
          while (jsEnd > jsStart && buf[jsEnd] === 0) jsEnd--;
          jsEnd++;
          break;
        }
        scanPos = nextBunfs + 1;
      }

      const content = buf.subarray(jsStart, jsEnd).toString("utf-8");
      candidates.push({ offset: jsStart, size: content.length, content });
    }

    searchFrom = idx + cliPath.length;
  }

  if (candidates.length === 0) {
    throw new Error("Could not find cli.js in binary");
  }

  // Pick the smaller copy (~10MB readable source, not ~37MB bytecode)
  candidates.sort((a, b) => a.size - b.size);
  return candidates[0].content;
}

// ── Patch application ─────────────────────────────────────────────────────

/**
 * Apply a same-length string replacement to JS content.
 * Returns { content, occurrences }.
 */
export function applyReplacement(content, find, replace) {
  if (replace.length > find.length) {
    throw new Error(`Replacement is longer than original (${replace.length} > ${find.length})`);
  }
  // Pad replacement with spaces if shorter
  const padded = replace + " ".repeat(find.length - replace.length);

  let occurrences = 0;
  let result = content;
  while (result.includes(find)) {
    result = result.replace(find, padded);
    occurrences++;
  }
  return { content: result, occurrences };
}

/**
 * Apply a same-length replacement to a binary Buffer (patches both cli.js copies).
 * Returns { buffer, occurrences }.
 */
export function applyReplacementBinary(buffer, find, replace) {
  const origBuf = Buffer.from(find, "utf-8");
  const replBuf = Buffer.from(replace, "utf-8");

  if (replBuf.length > origBuf.length) {
    throw new Error(`Replacement is longer than original (${replBuf.length} > ${origBuf.length})`);
  }

  const padded = Buffer.alloc(origBuf.length, 0x20);
  replBuf.copy(padded);

  let occurrences = 0;
  let searchFrom = 0;
  while (true) {
    const idx = buffer.indexOf(origBuf, searchFrom);
    if (idx === -1) break;
    padded.copy(buffer, idx);
    occurrences++;
    searchFrom = idx + origBuf.length;
  }
  return { buffer, occurrences };
}

/**
 * Apply a JS insertion after a marker string.
 * Returns { content, position } or throws if marker not found.
 */
export function applyInsertion(content, insertAfter, code) {
  const idx = content.indexOf(insertAfter);
  if (idx === -1) {
    throw new Error(`Insertion marker not found: ${insertAfter.substring(0, 60)}...`);
  }
  const position = idx + insertAfter.length;
  const result = content.substring(0, position) + "\n" + code + "\n" + content.substring(position);
  return { content: result, position };
}

// ── Binary management ─────────────────────────────────────────────────────

/** Backup the binary to .orig if not already backed up. Returns backup path. */
export function backupBinary(binaryPath) {
  const backupPath = binaryPath + ".orig";
  if (!existsSync(backupPath)) {
    copyFileSync(binaryPath, backupPath);
  }
  return backupPath;
}

/** Restore the binary from .orig backup. */
export function restoreBinary(binaryPath) {
  const backupPath = binaryPath + ".orig";
  if (!existsSync(backupPath)) {
    throw new Error(`No backup found at ${backupPath}`);
  }
  copyFileSync(backupPath, binaryPath);
  chmodSync(binaryPath, 0o755);
}

/** Ad-hoc codesign on macOS. No-op if codesign fails. */
export function codesign(binaryPath) {
  try {
    execSync(`codesign --force --sign - ${binaryPath} 2>&1`, { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/** Verify a binary works by running --version. */
export function verify(binaryPath) {
  try {
    const ver = execSync(`${binaryPath} --version 2>&1`, {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    return { ok: true, version: ver };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Template resolution ───────────────────────────────────────────────────

/**
 * Resolve a template patch against the current JS source.
 *
 * Template patches use stable structural patterns (error messages, property
 * names, call signatures) to derive minified variable names at apply-time,
 * making them resilient across CLI version updates.
 *
 * @param {string} jsContent - The full extracted JS source
 * @param {object} spec - The patch spec with anchor, extractors, codeFile content, insertAfter
 * @returns {{ code: string, insertAfter: string, vars: Record<string, string> }}
 */
export function resolveTemplate(jsContent, spec) {
  // 1. Find anchor region — a unique stable string to locate the right area
  const anchorIdx = jsContent.indexOf(spec.anchor);
  if (anchorIdx === -1) {
    throw new Error(`Template anchor not found: "${spec.anchor.substring(0, 60)}..."`);
  }

  // Extract a wide region around the anchor for extractor matching.
  // Some variables (like session loaders) are defined in nearby functions
  // that can be 15-20K chars away, so we use a generous window.
  const regionStart = Math.max(0, anchorIdx - 5000);
  const regionEnd = Math.min(jsContent.length, anchorIdx + 25000);
  const region = jsContent.substring(regionStart, regionEnd);

  // 2. Run extractors in order, building vars map
  const vars = {};
  for (const [name, rawPattern] of Object.entries(spec.extractors)) {
    // Interpolate previously resolved vars into the pattern
    let pattern = rawPattern;
    for (const [k, v] of Object.entries(vars)) {
      pattern = pattern.replaceAll(`{{${k}}}`, v);
    }

    const regex = new RegExp(pattern);
    const match = region.match(regex);
    if (!match || !match[1]) {
      throw new Error(`Template extractor "${name}" failed: /${pattern}/ not found near anchor`);
    }
    vars[name] = match[1];
  }

  // 3. Interpolate template code with resolved vars
  let code = spec._templateCode;
  for (const [k, v] of Object.entries(vars)) {
    code = code.replaceAll(`{{${k}}}`, v);
  }

  // 4. Interpolate insertAfter marker
  let insertAfter = spec.insertAfter;
  for (const [k, v] of Object.entries(vars)) {
    insertAfter = insertAfter.replaceAll(`{{${k}}}`, v);
  }

  return { code, insertAfter, vars };
}

// ── Utilities ─────────────────────────────────────────────────────────────

/** SHA256 hex digest. */
export function checksum(data) {
  return createHash("sha256").update(data).digest("hex");
}

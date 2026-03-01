#!/usr/bin/env bun
/**
 * patch-binary.js — In-place binary patcher for Claude Code's WebFetch
 *
 * Patches:
 *  1. Skip Haiku summarization (return raw markdown instead)
 *  2. (Future) Replace Turndown with Cloudflare API
 *
 * Usage:
 *   bun run patch-binary.js [--restore]
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from "fs";
import { execSync } from "child_process";

const HOME = process.env.HOME;

function findClaudeBinary() {
  const out = execSync("readlink -f $(which claude) 2>/dev/null || which claude", { encoding: "utf-8" }).trim();
  if (!existsSync(out)) {
    console.error(`Claude binary not found: ${out}`);
    process.exit(1);
  }
  return out;
}

const binaryPath = findClaudeBinary();
const backupPath = binaryPath + ".orig";
const restoreMode = process.argv.includes("--restore");

if (restoreMode) {
  if (!existsSync(backupPath)) {
    console.error("No backup found to restore");
    process.exit(1);
  }
  copyFileSync(backupPath, binaryPath);
  chmodSync(binaryPath, 0o755);
  console.log("Restored original binary from backup.");
  process.exit(0);
}

// Backup
if (!existsSync(backupPath)) {
  console.log(`Backing up: ${backupPath}`);
  copyFileSync(binaryPath, backupPath);
} else {
  console.log(`Backup exists: ${backupPath}`);
}

console.log(`Patching: ${binaryPath}`);
const buf = Buffer.from(readFileSync(binaryPath));

// Helper: find and replace a string in the binary, padding with spaces if shorter
function patchString(buffer, original, replacement, description) {
  const origBuf = Buffer.from(original, "utf-8");
  const replBuf = Buffer.from(replacement, "utf-8");

  if (replBuf.length > origBuf.length) {
    console.error(`FATAL: Replacement is longer than original for: ${description}`);
    console.error(`  Original: ${origBuf.length} bytes`);
    console.error(`  Replacement: ${replBuf.length} bytes`);
    process.exit(1);
  }

  // Pad replacement with spaces to match original length
  const padded = Buffer.alloc(origBuf.length, 0x20); // fill with spaces
  replBuf.copy(padded);

  // Find ALL occurrences (there are 2 copies of cli.js in the binary)
  let count = 0;
  let searchFrom = 0;
  while (true) {
    const idx = buffer.indexOf(origBuf, searchFrom);
    if (idx === -1) break;
    padded.copy(buffer, idx);
    count++;
    searchFrom = idx + origBuf.length;
  }

  if (count === 0) {
    console.error(`FATAL: Pattern not found for: ${description}`);
    console.error(`  Pattern: ${original.substring(0, 80)}...`);
    process.exit(1);
  }

  console.log(`  ${description}: ${count} occurrence(s) patched`);
  return count;
}

// ========================================
// PATCH 1: Skip Haiku summarization
// ========================================
// In the WebFetch call() function:
// Original: if(J&&G.includes("text/markdown")&&$.length<lzR)C=$;else C=await ufB(R,$,A.signal,_,J)
// We replace the else branch to just return raw markdown
patchString(
  buf,
  'else C=await ufB(R,$,A.signal,_,J)',
  'else C=$',
  "Skip Haiku summarization"
);

// ========================================
// PATCH 2 (optional): Increase maxResultSizeChars
// ========================================
// The tool has maxResultSizeChars:1e5 which truncates output to 100K chars.
// Since we're not summarizing anymore, the full markdown goes back to Claude.
// Bump to 500K to get more content through.
// (This is in the fW tool object definition)
// Note: this might affect context window usage, so keep it reasonable
// Actually let's leave this alone for now — 100K of clean markdown is plenty

// Write patched binary
writeFileSync(binaryPath, buf);
chmodSync(binaryPath, 0o755);
console.log(`\nPatched binary written: ${binaryPath}`);

// Try to re-codesign on macOS
try {
  execSync(`codesign --force --sign - ${binaryPath} 2>&1`, { encoding: "utf-8" });
  console.log("Re-signed binary (ad-hoc)");
} catch (e) {
  console.log("Note: codesign failed, binary may still work unsigned");
}

// Verify
try {
  const ver = execSync(`${binaryPath} --version 2>&1`, { encoding: "utf-8", timeout: 10000 }).trim();
  console.log(`\nVerification: ${ver}`);
  console.log("Patch successful!");
} catch (e) {
  console.error("\nWARNING: Patched binary failed. Restoring backup...");
  copyFileSync(backupPath, binaryPath);
  chmodSync(binaryPath, 0o755);
  console.error("Restored original. The bytecode cache may need invalidation.");
  process.exit(1);
}

console.log(`\nTo restore original: bun run ${import.meta.path} --restore`);

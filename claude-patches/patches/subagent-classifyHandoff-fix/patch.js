#!/usr/bin/env bun
/**
 * Fix: classifyHandoffIfNeeded is not defined
 *
 * Every Task tool subagent crashes on completion because classifyHandoffIfNeeded
 * is called but never defined in the bundled cli.js. This patch replaces the
 * call with an async no-op that returns null, allowing agents to complete normally.
 *
 * Usage:
 *   bun run patches/subagent-classifyHandoff-fix/patch.js [--restore]
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from "fs";
import { execSync } from "child_process";

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
  const padded = Buffer.alloc(origBuf.length, 0x20);
  replBuf.copy(padded);

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

// Replace the undefined classifyHandoffIfNeeded call with an async no-op
patchString(
  buf,
  "ZR=await classifyHandoffIfNeeded({agentMessages:IT,toolPermissionContext:TR.toolPermissionContext,abortSignal:QT.abortController.signal,isNonInteractiveSession:G.options.isNonInteractiveSession,subagentType:R,totalToolUseCount:NT.totalToolUseCount})",
  "ZR=await (async()=>null)()",
  "Fix classifyHandoffIfNeeded ReferenceError"
);

writeFileSync(binaryPath, buf);
chmodSync(binaryPath, 0o755);
console.log(`\nPatched binary written: ${binaryPath}`);

// Re-codesign on macOS
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

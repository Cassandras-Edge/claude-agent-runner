#!/usr/bin/env bun
/**
 * Generic Claude Code binary patcher.
 *
 * Usage:
 *   bun run patch.js --find "original" --replace "replacement"
 *   bun run patch.js --restore
 *
 * Finds all occurrences of --find in the binary and replaces with --replace.
 * Replacement is padded with spaces if shorter. Must not be longer.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from "fs";
import { execSync } from "child_process";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    find: { type: "string" },
    replace: { type: "string" },
    restore: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

function findBinary() {
  return execSync("readlink -f $(which claude) 2>/dev/null || which claude", { encoding: "utf-8" }).trim();
}

const binaryPath = findBinary();
const backupPath = binaryPath + ".orig";

if (values.restore) {
  if (!existsSync(backupPath)) { console.error("No backup found"); process.exit(1); }
  copyFileSync(backupPath, binaryPath);
  chmodSync(binaryPath, 0o755);
  console.log("Restored.");
  process.exit(0);
}

if (!values.find || !values.replace) {
  console.error("Usage: bun run patch.js --find 'original' --replace 'replacement'");
  process.exit(1);
}

const origBuf = Buffer.from(values.find, "utf-8");
const replBuf = Buffer.from(values.replace, "utf-8");

if (replBuf.length > origBuf.length) {
  console.error(`Replacement (${replBuf.length}b) is longer than original (${origBuf.length}b)`);
  process.exit(1);
}

const padded = Buffer.alloc(origBuf.length, 0x20);
replBuf.copy(padded);

if (!existsSync(backupPath)) {
  copyFileSync(binaryPath, backupPath);
  console.log(`Backup: ${backupPath}`);
}

const buf = Buffer.from(readFileSync(binaryPath));
let count = 0, from = 0;
while (true) {
  const idx = buf.indexOf(origBuf, from);
  if (idx === -1) break;
  if (!values["dry-run"]) padded.copy(buf, idx);
  count++;
  from = idx + origBuf.length;
}

if (count === 0) { console.error("Pattern not found"); process.exit(1); }
console.log(`${values["dry-run"] ? "Would patch" : "Patched"} ${count} occurrence(s)`);

if (!values["dry-run"]) {
  writeFileSync(binaryPath, buf);
  chmodSync(binaryPath, 0o755);
  try { execSync(`codesign --force --sign - ${binaryPath} 2>&1`); } catch {}

  try {
    const v = execSync(`${binaryPath} --version 2>&1`, { encoding: "utf-8", timeout: 10000 }).trim();
    console.log(`Verified: ${v}`);
  } catch {
    console.error("Verification failed, restoring...");
    copyFileSync(backupPath, binaryPath);
    chmodSync(binaryPath, 0o755);
    process.exit(1);
  }
}

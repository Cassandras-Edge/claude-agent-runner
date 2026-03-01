#!/usr/bin/env bun
/**
 * Unified Claude Code patcher.
 *
 * Extracts cli.js from the binary, applies all patches, and produces:
 *   dist/cli-patched.js   — for SDK (pathToClaudeCodeExecutable)
 *   dist/claude-patched    — patched binary for CLI usage
 *   dist/metadata.json     — version + patch manifest
 *
 * Usage:
 *   bun run scripts/patch-all.js              # apply all patches
 *   bun run scripts/patch-all.js --dry-run    # preview without writing
 *   bun run scripts/patch-all.js --js-only    # only produce cli-patched.js (skip binary)
 *   bun run scripts/patch-all.js --restore    # restore original binary
 *   bun run scripts/patch-all.js --install    # apply + replace system binary
 */

import { readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { mkdirSync } from "fs";
import {
  findBinary,
  getVersion,
  extractJS,
  applyReplacement,
  applyReplacementBinary,
  applyInsertion,
  resolveTemplate,
  backupBinary,
  restoreBinary,
  codesign,
  verify,
  checksum,
} from "../lib/patcher.js";

const ROOT = dirname(dirname(import.meta.path));
const PATCHES_DIR = join(ROOT, "patches");
const DIST_DIR = join(ROOT, "dist");

// ── CLI args ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");
const jsOnly = args.has("--js-only");
const restoreMode = args.has("--restore");
const installMode = args.has("--install");

// --binary <path>: operate on a snapshot instead of the system binary
let customBinary = null;
const binaryIdx = argv.indexOf("--binary");
if (binaryIdx !== -1 && argv[binaryIdx + 1]) {
  customBinary = argv[binaryIdx + 1];
}

// ── Restore mode ──────────────────────────────────────────────────────────

if (restoreMode) {
  const binaryPath = customBinary || findBinary();
  try {
    restoreBinary(binaryPath);
    console.log(`Restored: ${binaryPath}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  process.exit(0);
}

// ── Load patch specs ──────────────────────────────────────────────────────

function loadPatches() {
  const patches = [];
  const dirs = readdirSync(PATCHES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const dir of dirs) {
    const specPath = join(PATCHES_DIR, dir, "spec.json");
    if (!existsSync(specPath)) continue;

    const spec = JSON.parse(readFileSync(specPath, "utf-8"));

    // For insertion patches, load the code file
    if (spec.type === "insertion" && spec.codeFile) {
      const codePath = join(PATCHES_DIR, dir, spec.codeFile);
      if (!existsSync(codePath)) {
        console.error(`Missing code file: ${codePath}`);
        process.exit(1);
      }
      spec._code = readFileSync(codePath, "utf-8");
    }

    // For template patches, load the template code file
    if (spec.type === "template" && spec.codeFile) {
      const codePath = join(PATCHES_DIR, dir, spec.codeFile);
      if (!existsSync(codePath)) {
        console.error(`Missing template file: ${codePath}`);
        process.exit(1);
      }
      spec._templateCode = readFileSync(codePath, "utf-8");
    }

    if (spec.disabled) continue;

    spec._dir = dir;
    patches.push(spec);
  }

  return patches;
}

// ── Main ──────────────────────────────────────────────────────────────────

const binaryPath = customBinary || findBinary();
const version = getVersion(binaryPath);
console.log(`Binary: ${binaryPath}`);
console.log(`Version: ${version}`);

const patches = loadPatches();
if (patches.length === 0) {
  console.error("No patch specs found in patches/*/spec.json");
  process.exit(1);
}
console.log(`\nFound ${patches.length} patch(es):`);
for (const p of patches) {
  console.log(`  - ${p.id} (${p.type}, target: ${p.target})`);
}

// ── Extract JS ────────────────────────────────────────────────────────────

let jsContent;
if (binaryPath.endsWith(".js")) {
  // npm-installed on Linux: cli.js is already plain JavaScript
  console.log("\nReading cli.js directly (npm-installed, not a compiled binary)...");
  jsContent = readFileSync(binaryPath, "utf-8");
  console.log(`  Read ${(jsContent.length / 1024 / 1024).toFixed(1)} MB`);
} else {
  console.log("\nExtracting cli.js from binary...");
  jsContent = extractJS(binaryPath);
  console.log(`  Extracted ${(jsContent.length / 1024 / 1024).toFixed(1)} MB`);
}

// ── Apply patches to JS ──────────────────────────────────────────────────

console.log("\nApplying patches to JS:");
const applied = [];

// Replacements first (order matters less, but be consistent)
const skipped = [];
for (const p of patches.filter(p => p.type === "replacement")) {
  const result = applyReplacement(jsContent, p.find, p.replace);
  if (result.occurrences === 0) {
    console.error(`  SKIP: ${p.id} — pattern not found in JS`);
    skipped.push(p.id);
    continue;
  }
  jsContent = result.content;
  applied.push({ ...p, occurrences: result.occurrences });
  console.log(`  ${p.id}: ${result.occurrences} occurrence(s)`);
}

// Then insertions
for (const p of patches.filter(p => p.type === "insertion")) {
  try {
    const result = applyInsertion(jsContent, p.insertAfter, p._code);
    jsContent = result.content;
    applied.push({ ...p, position: result.position });
    console.log(`  ${p.id}: inserted at position ${result.position}`);
  } catch (e) {
    console.error(`  SKIP: ${p.id} — ${e.message}`);
    skipped.push(p.id);
  }
}

// Then templates (resolve variables from structural patterns, then insert)
for (const p of patches.filter(p => p.type === "template")) {
  try {
    const resolved = resolveTemplate(jsContent, p);
    const result = applyInsertion(jsContent, resolved.insertAfter, resolved.code);
    jsContent = result.content;
    applied.push({ ...p, position: result.position, vars: resolved.vars });
    console.log(`  ${p.id}: resolved vars: ${JSON.stringify(resolved.vars)}`);
    console.log(`  ${p.id}: inserted at position ${result.position}`);
  } catch (e) {
    console.error(`  SKIP: ${p.id} — ${e.message}`);
    skipped.push(p.id);
  }
}

// ── Apply replacement patches to binary ──────────────────────────────────

let binaryBuf;
if (!jsOnly) {
  console.log("\nApplying replacement patches to binary copy...");
  binaryBuf = Buffer.from(readFileSync(binaryPath));

  for (const p of patches.filter(p => p.type === "replacement" && p.target === "both")) {
    if (skipped.includes(p.id)) continue;
    const result = applyReplacementBinary(binaryBuf, p.find, p.replace);
    if (result.occurrences === 0) {
      console.error(`  SKIP: ${p.id} — pattern not found in binary`);
      continue;
    }
    console.log(`  ${p.id}: ${result.occurrences} occurrence(s) in binary`);
  }
}

// ── Write outputs ─────────────────────────────────────────────────────────

if (dryRun) {
  console.log("\n--dry-run: no files written");
  process.exit(0);
}

mkdirSync(DIST_DIR, { recursive: true });

// Patched JS
const jsOutPath = join(DIST_DIR, "cli-patched.js");
writeFileSync(jsOutPath, jsContent);
console.log(`\nWrote: ${jsOutPath} (${(jsContent.length / 1024 / 1024).toFixed(1)} MB)`);

if (!jsOnly) {
  // Patched binary
  const binOutPath = join(DIST_DIR, "claude-patched");
  writeFileSync(binOutPath, binaryBuf);
  chmodSync(binOutPath, 0o755);
  const signed = codesign(binOutPath);
  console.log(`Wrote: ${binOutPath} (${(binaryBuf.length / 1024 / 1024).toFixed(1)} MB${signed ? ", signed" : ""})`);

  // Verify binary
  const check = verify(binOutPath);
  if (!check.ok) {
    console.error(`\nWARNING: Patched binary verification failed: ${check.error}`);
    process.exit(1);
  }
  console.log(`Verified: ${check.version}`);
}

// Metadata
const metadata = {
  claudeVersion: version,
  timestamp: new Date().toISOString(),
  binarySource: binaryPath,
  jsOnly,
  patches: applied.map(p => ({
    id: p.id,
    type: p.type,
    target: p.target,
    description: p.description,
    ...(p.occurrences !== undefined && { occurrences: p.occurrences }),
    ...(p.position !== undefined && { position: p.position }),
    ...(p.vars !== undefined && { vars: p.vars }),
  })),
  skipped,
  checksums: {
    patchedJS: checksum(jsContent),
    ...(binaryBuf ? { patchedBinary: checksum(binaryBuf) } : {}),
  },
};
const metaPath = join(DIST_DIR, "metadata.json");
writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + "\n");
console.log(`Wrote: ${metaPath}`);

// ── Install mode ──────────────────────────────────────────────────────────

if (installMode && !jsOnly) {
  const binOutPath = join(DIST_DIR, "claude-patched");
  console.log("\n--install: replacing system binary...");
  backupBinary(binaryPath);
  copyFileSync(binOutPath, binaryPath);
  chmodSync(binaryPath, 0o755);
  codesign(binaryPath);
  const installCheck = verify(binaryPath);
  if (!installCheck.ok) {
    console.error("Install verification failed, restoring...");
    restoreBinary(binaryPath);
    process.exit(1);
  }
  console.log(`Installed: ${binaryPath}`);
}

if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} patch(es): ${skipped.join(", ")}`);
  console.log("(Marker strings not found — may need updating for this CLI version)");
}

console.log(`\nDone. Applied ${applied.length}/${patches.length} patches.`);

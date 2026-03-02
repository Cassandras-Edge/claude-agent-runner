#!/usr/bin/env bun
/**
 * Unified Claude Code patcher — v2 step-based engine.
 *
 * Extracts cli.js from the binary, applies all patches via the step engine,
 * and produces:
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
  applyReplacementBinary,
  backupBinary,
  restoreBinary,
  codesign,
  verify,
  checksum,
} from "../lib/patcher.js";
import { applyPatch } from "../lib/engine.js";

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

    if (spec.disabled) continue;

    // Resolve code_file references in steps
    if (spec.steps) {
      for (const step of spec.steps) {
        if (step.code_file) {
          const codePath = join(PATCHES_DIR, dir, step.code_file);
          if (!existsSync(codePath)) {
            console.error(`Missing code file: ${codePath}`);
            process.exit(1);
          }
          step.code = readFileSync(codePath, "utf-8");
        }
      }
    }

    spec._dir = dir;
    patches.push(spec);
  }

  return patches;
}

// ── Main ──────────────────────────────────────────────────────────────────

const binaryPath = customBinary || findBinary();
const version = getVersion(binaryPath);
const cliVersion = version.replace(/^.*?(\d+\.\d+\.\d+).*$/, "$1");
console.log(`Binary: ${binaryPath}`);
console.log(`Version: ${version}`);

const patches = loadPatches();
if (patches.length === 0) {
  console.error("No patch specs found in patches/*/spec.json");
  process.exit(1);
}
console.log(`\nFound ${patches.length} patch(es):`);
for (const p of patches) {
  console.log(`  - ${p.id} (${p.steps.length} step(s), target: ${p.target})`);
}

// ── Extract JS ────────────────────────────────────────────────────────────

let jsContent;
if (binaryPath.endsWith(".js")) {
  console.log("\nReading cli.js directly (npm-installed, not a compiled binary)...");
  jsContent = readFileSync(binaryPath, "utf-8");
  console.log(`  Read ${(jsContent.length / 1024 / 1024).toFixed(1)} MB`);
} else {
  console.log("\nExtracting cli.js from binary...");
  jsContent = extractJS(binaryPath);
  console.log(`  Extracted ${(jsContent.length / 1024 / 1024).toFixed(1)} MB`);
}

// ── Apply patches to JS via step engine ───────────────────────────────────

console.log("\nApplying patches to JS:");
const applied = [];
const skipped = [];

for (const spec of patches) {
  try {
    const result = await applyPatch(jsContent, spec, { cliVersion });
    jsContent = result.content;
    applied.push({ id: spec.id, target: spec.target, description: spec.description, vars: result.vars });

    // Show step results
    for (const s of result.diag.steps) {
      if (s.detail) console.log(`  ${spec.id}/${s.id}: ${s.detail}`);
    }
  } catch (e) {
    console.error(`  SKIP: ${spec.id} — ${e.message}`);
    skipped.push(spec.id);
  }
}

// ── Apply replacement patches to binary ──────────────────────────────────

let binaryBuf;
if (!jsOnly) {
  console.log("\nApplying replacement patches to binary copy...");
  binaryBuf = Buffer.from(readFileSync(binaryPath));

  for (const spec of patches) {
    if (spec.target !== "both") continue;
    if (skipped.includes(spec.id)) continue;

    // For binary, only apply find_replace steps with pad_to_length
    for (const step of spec.steps) {
      if (step.type !== "find_replace") continue;

      let find = step.find;
      let replace = step.replace;
      // Interpolate vars from applied result
      const appliedEntry = applied.find(a => a.id === spec.id);
      if (appliedEntry?.vars) {
        for (const [k, v] of Object.entries(appliedEntry.vars)) {
          find = find.replaceAll(`{{${k}}}`, v);
          replace = replace.replaceAll(`{{${k}}}`, v);
        }
      }

      const result = applyReplacementBinary(binaryBuf, find, replace);
      if (result.occurrences === 0) {
        console.error(`  SKIP: ${spec.id}/${step.id} — pattern not found in binary`);
        continue;
      }
      console.log(`  ${spec.id}/${step.id}: ${result.occurrences} occurrence(s) in binary`);
    }
  }
}

// ── Write outputs ─────────────────────────────────────────────────────────

if (dryRun) {
  console.log("\n--dry-run: no files written");
  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length} patch(es): ${skipped.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nDone. Applied ${applied.length}/${patches.length} patches.`);
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
    target: p.target,
    description: p.description,
    ...(Object.keys(p.vars || {}).length > 0 && { vars: p.vars }),
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

import { readFileSync, writeFileSync } from "fs";

const data = readFileSync("/tmp/claude/claude-extracted/src/entrypoints/cli.js");

// Find the start of actual JS - "// @bun" or "(function"
const jsStart = data.indexOf("// @bun");
if (jsStart === -1) {
  console.error("Could not find JS start");
  process.exit(1);
}

const cleaned = data.subarray(jsStart);
writeFileSync("/tmp/claude/cli-clean.js", cleaned);
console.log(`Stripped ${jsStart} bytes of prefix`);
console.log(`Clean JS size: ${(cleaned.length / 1024 / 1024).toFixed(2)} MB`);

// Verify it contains WebFetch
const str = cleaned.toString();
const matches = [
  "WebFetch",
  "turndown",
  "web_fetch_apply",
  "TurndownService",
  "function vfB",
  "yfB().turndown",
  "new yfB",
];
for (const m of matches) {
  const count = str.split(m).length - 1;
  if (count > 0) console.log(`  Found "${m}": ${count} occurrences`);
}

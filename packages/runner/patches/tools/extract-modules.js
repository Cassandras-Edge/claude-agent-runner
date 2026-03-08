import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const binaryPath = process.argv[2] || "snapshots/cli.js";
const buf = readFileSync(binaryPath);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const decoder = new TextDecoder();

// Find all /$bunfs/root/ paths in the latter half of the binary
// These are the embedded module paths
const marker = "/$bunfs/root/";
const paths = [];
let searchFrom = Math.floor(buf.length * 0.3);

while (true) {
  const idx = buf.indexOf(marker, searchFrom);
  if (idx === -1) break;

  // Read until null byte or non-printable to get the full path
  let end = idx;
  while (end < buf.length && buf[end] >= 0x20 && buf[end] < 0x7f) end++;
  const path = buf.subarray(idx, end).toString();

  // Check if this looks like a real module path (ends in .js or similar)
  if (path.match(/\.(js|mjs|cjs|ts|json|node)$/)) {
    paths.push({ offset: idx, path, pathLen: end - idx });
  }

  searchFrom = end + 1;
}

console.log(`Found ${paths.length} embedded module paths:`);
paths.forEach((p, i) => {
  console.log(`  [${i}] @${p.offset}: ${p.path} (pathLen=${p.pathLen})`);
});

// Now, for each path, the content follows after the path + null byte(s)
// The content ends where the next path begins (roughly)
// Let's extract each module

const outputDir = "/tmp/claude/claude-extracted";
mkdirSync(outputDir, { recursive: true });

for (let i = 0; i < paths.length; i++) {
  const p = paths[i];
  const cleanPath = p.path.replace("/$bunfs/root/", "");

  // Content starts after the path string + separator byte(s)
  // Try offset+pathLen+1 (null separator)
  let contentStart = p.offset + p.pathLen;
  // Skip null/separator bytes
  while (contentStart < buf.length && buf[contentStart] === 0) contentStart++;

  // Content ends at the start of the next path, minus some metadata bytes
  // Or for the last module, at the metadata region
  let contentEnd;
  if (i < paths.length - 1) {
    // The next path is preceded by its metadata
    // Content goes until we hit the next /$bunfs path (minus some metadata bytes before it)
    // But there could be separator bytes between content and next path
    contentEnd = paths[i + 1].offset;
    // Walk backwards from next path to skip null/metadata bytes
    // Actually, let's just take everything up to the next path start
    // and let the JS be potentially a bit longer (extra nulls at end won't matter)

    // Better: look for the last non-null byte before the next path
    let trimEnd = contentEnd - 1;
    while (trimEnd > contentStart && buf[trimEnd] === 0) trimEnd--;
    contentEnd = trimEnd + 1;
  } else {
    // Last module - content goes until the metadata region
    // Find the metadata by looking for the trailer
    const trailerStr = "---- Bun! ----";
    let trailerOffset = buf.lastIndexOf(trailerStr);
    // Content ends well before the trailer - there's metadata in between
    // Use the metadata offset we know: modulesPtrOffset from the end
    contentEnd = trailerOffset - 1000; // rough, will trim

    // Better: just look for where JS-like content ends
    let trimEnd = contentEnd;
    while (trimEnd > contentStart && buf[trimEnd] !== 0x0a && buf[trimEnd] !== 0x7d && buf[trimEnd] !== 0x3b) trimEnd--;
    contentEnd = trimEnd + 1;
  }

  const content = buf.subarray(contentStart, contentEnd);
  const sizeMB = (content.length / 1024 / 1024).toFixed(2);

  // Quick sanity check - first few bytes should be JS-like
  const preview = content.subarray(0, 80).toString();
  const isJS = preview.match(/^[\s\S]*[a-zA-Z({\/]/);

  console.log(`\n[${i}] ${cleanPath} (${sizeMB} MB) start=${contentStart}`);
  console.log(`    Preview: ${JSON.stringify(preview.substring(0, 100))}`);

  const outPath = join(outputDir, cleanPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
}

console.log(`\nExtracted to: ${outputDir}`);
console.log(`Total modules: ${paths.length}`);

import { readFileSync } from "fs";

const buf = readFileSync("/Users/andrew.sulistio/.local/share/claude/versions/2.1.42");
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

// Find trailer
const trailerStr = "---- Bun! ----";
let trailerOffset = -1;
for (let i = buf.length - 1; i >= 0; i--) {
  if (buf[i] === 0x2d && buf.subarray(i, i + trailerStr.length).toString() === trailerStr) {
    trailerOffset = i;
    break;
  }
}
const virtualEnd = trailerOffset + trailerStr.length + 1;
console.log(`Trailer at: ${trailerOffset}, virtualEnd: ${virtualEnd}`);

// Dump all u32 values in the last 128 bytes before trailer
console.log("\n--- u32 LE values before trailer (relative to virtualEnd) ---");
for (let offset = 4; offset <= 128; offset += 4) {
  const val = view.getUint32(virtualEnd - offset, true);
  console.log(`  end-${offset}: ${val} (0x${val.toString(16)})`);
}

// Also try treating the metadata region differently
// Maybe the format changed in newer Bun versions
// Let's look at the raw bytes around the metadata
console.log("\n--- Raw bytes at virtualEnd-80 to virtualEnd ---");
const slice = buf.subarray(virtualEnd - 80, virtualEnd);
console.log(Buffer.from(slice).toString('hex').match(/.{1,8}/g).join(' '));

// Try different chunk sizes
const offsetByteCount = view.getUint32(virtualEnd - 48, true);
const modulesPtrOffset = view.getUint32(virtualEnd - 40, true);
const modulesPtrLength = view.getUint32(virtualEnd - 36, true);
console.log(`\noffsetByteCount: ${offsetByteCount}`);
console.log(`modulesPtrOffset: ${modulesPtrOffset}`);
console.log(`modulesPtrLength: ${modulesPtrLength}`);

for (let cs = 20; cs <= 40; cs += 4) {
  const n = modulesPtrLength / cs;
  if (n === Math.floor(n)) {
    console.log(`  chunkSize=${cs} -> ${n} modules (integer!)`);
  }
}

// Also check if there's a different interpretation
// Maybe modulesPtrLength isn't what we think
// Try reading at different positions
console.log("\n--- Trying alternate field positions ---");
for (let base = 28; base <= 80; base += 4) {
  const ptrLen = view.getUint32(virtualEnd - base, true);
  if (ptrLen > 0 && ptrLen < 10000) {
    for (let cs of [24, 28, 32, 36, 40]) {
      const n = ptrLen / cs;
      if (n === Math.floor(n) && n > 0 && n < 100) {
        console.log(`  end-${base} = ${ptrLen}, chunkSize=${cs} -> ${n} modules`);
      }
    }
  }
}

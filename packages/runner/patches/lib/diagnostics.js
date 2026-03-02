/**
 * DiagnosticCollector — structured diagnostics for patch step execution.
 *
 * Tracks which steps succeeded vs failed, captures the region around anchors,
 * shows expected vs actual content, and generates debug commands.
 */

export class DiagnosticCollector {
  constructor(patchId) {
    this.patchId = patchId;
    this.steps = []; // { id, type, status, detail?, region? }
  }

  /** Record a successful step. */
  success(stepId, type, detail) {
    this.steps.push({ id: stepId, type, status: "ok", detail });
  }

  /** Record a failed step with diagnostic context. */
  fail(stepId, type, error, context = {}) {
    this.steps.push({ id: stepId, type, status: "FAILED", error, ...context });
  }

  /** Format a human-readable diagnostic report. */
  report() {
    const lines = [`\n  Patch "${this.patchId}" diagnostics:`];
    for (const s of this.steps) {
      const icon = s.status === "ok" ? "  [ok]" : "  [FAIL]";
      lines.push(`${icon} step "${s.id}" (${s.type})`);
      if (s.detail) lines.push(`        ${s.detail}`);
      if (s.error) lines.push(`        Error: ${s.error}`);
      if (s.region) {
        lines.push(`        Region (${s.region.length} chars around offset ${s.regionOffset}):`);
        const snippet = s.region.substring(0, 200).replace(/\n/g, "\\n");
        lines.push(`        "${snippet}${s.region.length > 200 ? "..." : ""}"`);
      }
      if (s.matches) {
        lines.push(`        Found ${s.matches.length} match(es):`);
        for (const m of s.matches.slice(0, 5)) {
          const ctx = m.context.substring(0, 120).replace(/\n/g, "\\n");
          lines.push(`          offset ${m.offset}: "${ctx}..."`);
        }
        if (s.matches.length > 5) lines.push(`          ... and ${s.matches.length - 5} more`);
      }
      if (s.debugCmd) {
        lines.push(`        Debug: ${s.debugCmd}`);
      }
    }
    return lines.join("\n");
  }

  /** Did any step fail? */
  get hasFailed() {
    return this.steps.some(s => s.status === "FAILED");
  }
}

/**
 * Find all occurrences of a literal string in content, returning offsets + surrounding context.
 */
export function findAllOccurrences(content, needle, contextChars = 60) {
  const matches = [];
  let pos = 0;
  while (true) {
    const idx = content.indexOf(needle, pos);
    if (idx === -1) break;
    const start = Math.max(0, idx - contextChars);
    const end = Math.min(content.length, idx + needle.length + contextChars);
    matches.push({ offset: idx, context: content.substring(start, end) });
    pos = idx + 1;
  }
  return matches;
}

/**
 * Extract a region around an offset for diagnostic display.
 */
export function extractRegion(content, offset, before = 200, after = 200) {
  const start = Math.max(0, offset - before);
  const end = Math.min(content.length, offset + after);
  return { region: content.substring(start, end), regionOffset: start };
}

/**
 * Generate a node -e command to inspect a region of a file.
 */
export function debugCommand(filePath, offset, length = 500) {
  return `node -e "const fs=require('fs');const c=fs.readFileSync('${filePath}','utf8');console.log(c.substring(${offset},${offset + length}))"`;
}

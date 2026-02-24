/**
 * Ring buffer that stores the last N lines of stderr output for diagnostics.
 */
export function createStderrRingBuffer(maxLines: number) {
  const lines: string[] = [];
  return {
    push(chunk: string): void {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    tail(limit = maxLines): string[] {
      return lines.slice(-Math.max(1, Math.min(limit, maxLines)));
    },
  };
}

/**
 * Builds a structured error payload when the SDK query yields zero events.
 */
export function buildZeroEventError(
  reason: string,
  model: string,
  maxTurns: number | undefined,
  cwd: string,
  childEnvKeys: string[],
  stderrTail: string[],
): string {
  return JSON.stringify(
    {
      code: "claude_cli_no_events",
      reason,
      model,
      maxTurns,
      cwd,
      childEnvKeys,
      stderrTail,
    },
    null,
    2,
  );
}

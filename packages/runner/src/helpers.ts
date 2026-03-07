import { COMPACT_THRESHOLD_PCT } from "./config.js";
import { logger } from "./logger.js";
import { state } from "./state.js";

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

export function buildClaudeChildEnv(forceCompact = false): Record<string, string> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) {
    logger.error("runner.config", "missing_oauth_token", { session_id: state.SESSION_ID });
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for Claude child process");
  }

  return {
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/runner",
    USER: "runner",
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    TERM: "dumb",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: forceCompact ? "1" : String(COMPACT_THRESHOLD_PCT),
    CLAUDE_MEM_SOCKET: state.MEM_SOCKET_PATH,
    ENABLE_TOOL_SEARCH: "false",
  };
}

export function getJsonlPath(): string {
  if (!state.sdkSessionId) throw new Error("SDK session ID not yet established");
  return `/home/runner/.claude/projects/-workspace/${state.sdkSessionId}.jsonl`;
}

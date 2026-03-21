import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { SdkIpcSession } from "./sdk-ipc-session.js";
import { buildClaudeChildEnv } from "./helpers.js";
import { PATCHED_CLI_PATH } from "./config.js";
import { logger } from "./logger.js";
import { state } from "./state.js";

export interface PtyHandle {
  process: ChildProcess;
  session: SdkIpcSession;
  socketPath: string;
  rcSessionUrl?: string;
}

/**
 * Spawn Claude Code with a real PTY and connect to its sdk-ipc socket.
 *
 * Uses `script` command as a portable PTY allocator (works on Linux + macOS,
 * no native modules needed). The Claude Code process gets a real TTY which
 * enables the full TUI, while we communicate programmatically via the
 * sdk-ipc Unix socket.
 */
export async function spawnWithPty(overrides?: {
  cols?: number;
  rows?: number;
}): Promise<PtyHandle> {
  const sdkSocketPath = `/tmp/claude-sdk-ipc-${state.SESSION_ID || randomUUID()}.sock`;
  const memSocketPath = state.MEM_SOCKET_PATH;

  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...buildClaudeChildEnv(),
    TERM: "xterm-256color",
    CLAUDE_SDK_IPC_SOCKET: sdkSocketPath,
    CLAUDE_MEM_SOCKET: memSocketPath,
    // Disable tool search deferral (foot-gun from CLAUDE.md)
    ENABLE_TOOL_SEARCH: "false",
  };

  const claudePath = PATCHED_CLI_PATH || "claude";
  const claudeArgs: string[] = [
    // Run in SDK/print mode — same as the Agent SDK spawns it.
    // This is required for the sdk-ipc patch to fire (it hooks into C3$).
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
  ];

  if (state.PERMISSION_MODE === "bypassPermissions") {
    claudeArgs.push("--dangerously-skip-permissions");
  }

  // Set the working directory
  if (state.WORKSPACE) {
    claudeArgs.push("--add-dir", state.WORKSPACE);
  }

  // Model
  if (state.MODEL) {
    claudeArgs.push("--model", state.MODEL);
  }

  // System prompt
  if (state.SYSTEM_PROMPT) {
    claudeArgs.push("--system-prompt", state.SYSTEM_PROMPT);
  } else if (state.APPEND_SYSTEM_PROMPT) {
    claudeArgs.push("--append-system-prompt", state.APPEND_SYSTEM_PROMPT);
  }

  // Spawn directly — no PTY needed in print mode.
  // The sdk-ipc socket provides the programmatic channel, and
  // Remote Control provides web/mobile access.
  // Future: interactive mode + PTY for terminal relay.
  const executable = PATCHED_CLI_PATH ? "bun" : claudePath;
  const execArgs = PATCHED_CLI_PATH
    ? [PATCHED_CLI_PATH, ...claudeArgs]
    : claudeArgs;

  logger.info("runner.pty", "spawning", {
    session_id: state.SESSION_ID,
    executable,
    args: execArgs.slice(0, 8),
    sdk_socket: sdkSocketPath,
    mem_socket: memSocketPath,
  });

  const child = spawn(executable, execArgs, {
    env: childEnv,
    cwd: state.WORKSPACE || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.on("exit", (code, signal) => {
    logger.info("runner.pty", "process_exited", {
      session_id: state.SESSION_ID,
      exit_code: code,
      signal,
    });
  });

  // Store handle on state for PTY relay
  state.ptyProcess = child;
  state.ptySocketPath = sdkSocketPath;

  // Connect to sdk-ipc socket (retry until Claude Code starts up)
  const session = new SdkIpcSession();
  await session.connect(sdkSocketPath, 120, 250); // Up to 30s for startup

  logger.info("runner.pty", "sdk_ipc_connected", {
    session_id: state.SESSION_ID,
    sdk_session_id: session.sessionId,
  });

  let rcSessionUrl: string | undefined;

  // Enable remote control
  try {
    const rcResult = await session.query.enableRemoteControl(true);
    rcSessionUrl = rcResult?.session_url;
    if (rcSessionUrl) {
      logger.info("runner.pty", "remote_control_enabled", {
        session_id: state.SESSION_ID,
        session_url: rcSessionUrl,
      });
    }
  } catch (err) {
    logger.warn("runner.pty", "remote_control_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Configure MCP servers if specified
  if (Object.keys(state.MCP_SERVERS).length > 0) {
    try {
      await session.query.setMcpServers(state.MCP_SERVERS);
      logger.info("runner.pty", "mcp_servers_configured", {
        servers: Object.keys(state.MCP_SERVERS),
      });
    } catch (err) {
      logger.warn("runner.pty", "mcp_servers_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { process: child, session, socketPath: sdkSocketPath, rcSessionUrl };
}

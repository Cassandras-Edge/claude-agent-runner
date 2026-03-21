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
}

/**
 * Spawn Claude Code in INTERACTIVE mode with a real PTY.
 *
 * Uses `script` as a portable PTY allocator. The process gets a full TUI
 * (Ink rendering) while the sdk-ipc socket provides programmatic control.
 * Remote Control is enabled via --remote-control CLI flag.
 *
 * Three access channels on one process:
 *   1. PTY bytes (relayed to thin client for terminal access)
 *   2. sdk-ipc socket (runner programmatic control via ED())
 *   3. Remote Control (claude.ai/code web/mobile access)
 */
export async function spawnWithPty(): Promise<PtyHandle> {
  const sdkSocketPath = `/tmp/claude-sdk-ipc-${state.SESSION_ID || randomUUID()}.sock`;
  const memSocketPath = state.MEM_SOCKET_PATH;

  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...buildClaudeChildEnv(),
    TERM: "xterm-256color",
    CLAUDE_SDK_IPC_SOCKET: sdkSocketPath,
    CLAUDE_MEM_SOCKET: memSocketPath,
    ENABLE_TOOL_SEARCH: "false",
  };

  // Build Claude Code args for interactive mode (no --print)
  const claudeArgs: string[] = [
    "--remote-control",
    "--dangerously-skip-permissions",
  ];

  if (state.MODEL) {
    claudeArgs.push("--model", state.MODEL);
  }
  if (state.SYSTEM_PROMPT) {
    claudeArgs.push("--system-prompt", state.SYSTEM_PROMPT);
  } else if (state.APPEND_SYSTEM_PROMPT) {
    claudeArgs.push("--append-system-prompt", state.APPEND_SYSTEM_PROMPT);
  }
  if (state.WORKSPACE) {
    claudeArgs.push("--add-dir", state.WORKSPACE);
  }

  // Build the full command
  const executable = PATCHED_CLI_PATH ? "bun" : "claude";
  const execArgs = PATCHED_CLI_PATH
    ? [PATCHED_CLI_PATH, ...claudeArgs]
    : claudeArgs;

  // Use `script` to allocate a real PTY
  const platform = process.platform;
  let spawnCmd: string;
  let spawnArgs: string[];

  if (platform === "darwin") {
    spawnCmd = "script";
    spawnArgs = ["-q", "/dev/null", executable, ...execArgs];
  } else {
    spawnCmd = "script";
    const fullCmd = [executable, ...execArgs]
      .map(a => `'${a.replace(/'/g, "'\\''")}'`)
      .join(" ");
    spawnArgs = ["-qc", fullCmd, "/dev/null"];
  }

  logger.info("runner.pty", "spawning_interactive", {
    session_id: state.SESSION_ID,
    cmd: spawnCmd,
    claude_args: claudeArgs,
    sdk_socket: sdkSocketPath,
  });

  const child = spawn(spawnCmd, spawnArgs, {
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

  state.ptyProcess = child;
  state.ptySocketPath = sdkSocketPath;

  // Connect to sdk-ipc socket
  const session = new SdkIpcSession();
  await session.connect(sdkSocketPath, 120, 250);

  logger.info("runner.pty", "sdk_ipc_connected", {
    session_id: state.SESSION_ID,
    sdk_session_id: session.sessionId,
  });

  // Configure MCP servers if specified
  // Note: in interactive mode, MCP config comes from project settings.
  // This is for runner-injected MCP servers that aren't in project config.
  // Uses sdk-ipc prompt injection to run /mcp commands if needed.

  return { process: child, session, socketPath: sdkSocketPath };
}

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
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
 * Spawn Claude Code with the sdk-ipc socket for programmatic control.
 *
 * If `script` is available, spawns in interactive mode with a real PTY
 * (full TUI + Remote Control + sdk-ipc). Otherwise, spawns in print mode
 * (headless + Remote Control via control request + sdk-ipc).
 *
 * Both modes get the sdk-ipc socket since the patch is module-level.
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

  const executable = PATCHED_CLI_PATH ? "bun" : "claude";
  const hasScript = existsSync("/usr/bin/script") || existsSync("/usr/local/bin/script");

  let spawnCmd: string;
  let spawnArgs: string[];

  if (hasScript) {
    // Interactive mode with PTY — full TUI, RC via CLI flag
    const claudeArgs = [
      "--remote-control",
      "--dangerously-skip-permissions",
    ];
    if (state.MODEL) claudeArgs.push("--model", state.MODEL);
    if (state.SYSTEM_PROMPT) claudeArgs.push("--system-prompt", state.SYSTEM_PROMPT);
    else if (state.APPEND_SYSTEM_PROMPT) claudeArgs.push("--append-system-prompt", state.APPEND_SYSTEM_PROMPT);
    if (state.WORKSPACE) claudeArgs.push("--add-dir", state.WORKSPACE);

    const execArgs = PATCHED_CLI_PATH ? [PATCHED_CLI_PATH, ...claudeArgs] : claudeArgs;

    if (process.platform === "darwin") {
      spawnCmd = "script";
      spawnArgs = ["-q", "/dev/null", executable, ...execArgs];
    } else {
      spawnCmd = "script";
      const fullCmd = [executable, ...execArgs].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      spawnArgs = ["-qc", fullCmd, "/dev/null"];
    }

    logger.info("runner.pty", "spawning_interactive", {
      session_id: state.SESSION_ID,
      mode: "pty",
      claude_args: claudeArgs,
      sdk_socket: sdkSocketPath,
    });
  } else {
    // Print mode fallback — no PTY, but sdk-ipc + RC still work
    const claudeArgs = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (state.MODEL) claudeArgs.push("--model", state.MODEL);
    if (state.SYSTEM_PROMPT) claudeArgs.push("--system-prompt", state.SYSTEM_PROMPT);
    else if (state.APPEND_SYSTEM_PROMPT) claudeArgs.push("--append-system-prompt", state.APPEND_SYSTEM_PROMPT);
    if (state.WORKSPACE) claudeArgs.push("--add-dir", state.WORKSPACE);

    spawnCmd = executable;
    spawnArgs = PATCHED_CLI_PATH ? [PATCHED_CLI_PATH, ...claudeArgs] : claudeArgs;

    logger.info("runner.pty", "spawning_headless", {
      session_id: state.SESSION_ID,
      mode: "print",
      reason: "script_not_available",
      sdk_socket: sdkSocketPath,
    });
  }

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

  return { process: child, session, socketPath: sdkSocketPath };
}

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from "fs";
import { join } from "path";
import * as pty from "node-pty";
import { SdkIpcSession } from "./sdk-ipc-session.js";
import { buildClaudeChildEnv } from "./helpers.js";
import { PATCHED_CLI_PATH } from "./config.js";
import { logger } from "./logger.js";
import { state } from "./state.js";

export interface PtyHandle {
  pty: pty.IPty;
  session: SdkIpcSession;
  socketPath: string;
}

/**
 * Spawn Claude Code in interactive mode with a real PTY via node-pty.
 * Supports native resize, full TUI rendering, and the sdk-ipc socket.
 */
export async function spawnWithPty(): Promise<PtyHandle> {
  const sdkSocketPath = `/tmp/claude-sdk-ipc-${state.SESSION_ID || randomUUID()}.sock`;
  const memSocketPath = state.MEM_SOCKET_PATH;

  const baseEnv = buildClaudeChildEnv();
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...baseEnv,
    TERM: "xterm-256color",
    CLAUDE_SDK_IPC_SOCKET: sdkSocketPath,
    CLAUDE_MEM_SOCKET: memSocketPath,
    ENABLE_TOOL_SEARCH: "false",
  };

  const home = childEnv.HOME || "/home/runner";
  prepareClaudeConfig(home);
  prepareWorkspaceTrust(home);

  // Build Claude Code args for interactive mode
  const claudeArgs = [
    "--remote-control",
    "--dangerously-skip-permissions",
  ];
  if (state.MODEL) claudeArgs.push("--model", state.MODEL);
  if (state.SYSTEM_PROMPT) claudeArgs.push("--system-prompt", state.SYSTEM_PROMPT);
  else if (state.APPEND_SYSTEM_PROMPT) claudeArgs.push("--append-system-prompt", state.APPEND_SYSTEM_PROMPT);
  if (state.WORKSPACE) claudeArgs.push("--add-dir", state.WORKSPACE);

  const executable = PATCHED_CLI_PATH ? "bun" : "claude";
  const execArgs = PATCHED_CLI_PATH
    ? [PATCHED_CLI_PATH, ...claudeArgs]
    : claudeArgs;

  logger.info("runner.pty", "spawning_interactive", {
    session_id: state.SESSION_ID,
    mode: "node-pty",
    claude_args: claudeArgs,
    sdk_socket: sdkSocketPath,
  });

  const ptyProcess = pty.spawn(executable, execArgs, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: state.WORKSPACE || process.cwd(),
    env: childEnv,
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    logger.info("runner.pty", "process_exited", {
      session_id: state.SESSION_ID,
      exit_code: exitCode,
      signal,
    });
  });

  // Store handle on state for PTY relay
  state.ptyHandle = ptyProcess;
  state.ptySocketPath = sdkSocketPath;

  // Connect to sdk-ipc socket
  const session = new SdkIpcSession();
  await session.connect(sdkSocketPath, 120, 250);

  logger.info("runner.pty", "sdk_ipc_connected", {
    session_id: state.SESSION_ID,
    sdk_session_id: session.sessionId,
  });

  return { pty: ptyProcess, session, socketPath: sdkSocketPath };
}

/** Pre-create .claude.json to skip onboarding wizard. */
function prepareClaudeConfig(home: string): void {
  const claudeJsonPath = join(home, ".claude.json");
  if (existsSync(claudeJsonPath)) return;

  // Try restore from backup
  const backupDir = join(home, ".claude", "backups");
  try {
    if (existsSync(backupDir)) {
      const backups = readdirSync(backupDir)
        .filter(f => f.startsWith(".claude.json.backup."))
        .sort()
        .reverse();
      if (backups.length > 0) {
        copyFileSync(join(backupDir, backups[0]), claudeJsonPath);
        logger.info("runner.pty", "claude_json_restored", { backup: backups[0] });
        return;
      }
    }
  } catch {}

  writeFileSync(claudeJsonPath, JSON.stringify({
    theme: "dark",
    hasCompletedOnboarding: true,
    hasSeenOnboardingTip: true,
  }));
  logger.info("runner.pty", "claude_json_created");
}

/** Pre-write workspace trust settings. */
function prepareWorkspaceTrust(home: string): void {
  const workspacePath = state.WORKSPACE || "/workspace";
  const projectDir = join(home, ".claude", "projects", `-${workspacePath.replace(/\//g, "-").replace(/^-/, "")}`);
  try {
    mkdirSync(projectDir, { recursive: true });
    const trustFile = join(projectDir, "settings.json");
    if (!existsSync(trustFile)) {
      writeFileSync(trustFile, JSON.stringify({ isTrusted: true }));
      logger.info("runner.pty", "workspace_trust_preaccepted");
    }
  } catch {}
}

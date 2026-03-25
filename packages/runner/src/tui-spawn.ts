/**
 * spawnClaudeCodeProcess adapter for Option B architecture:
 *
 * The SDK calls spawnClaudeCodeProcess({ command, args, cwd, env, signal })
 * expecting a ChildProcess-like object with piped stdin/stdout.
 *
 * Instead of running Claude Code in stream-json mode, we:
 * 1. Spawn it in interactive mode inside a tmux session (full REPL TUI)
 * 2. Connect to the sdk-ipc unix socket for programmatic control
 * 3. Return a fake process that bridges SDK stdin/stdout to the socket
 *
 * The SDK thinks it's talking stream-json, but actually:
 * - Messages sent to stdin → parsed and forwarded to sdk-ipc socket
 * - Events from sdk-ipc socket → formatted as NDJSON on stdout
 * - The REPL renders in tmux, SSH users can attach
 */

import { spawn, type ChildProcess } from "child_process";
import { createConnection, type Socket } from "net";
import { Readable, Writable } from "stream";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger.js";
import { state } from "./state.js";
import { PATCHED_CLI_PATH } from "./config.js";
import { buildClaudeChildEnv } from "./helpers.js";

const SOCKET_CONNECT_TIMEOUT_MS = 120_000;
const SOCKET_CONNECT_INTERVAL_MS = 250;

interface SpawnConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}

/**
 * Create the spawnClaudeCodeProcess function for SDK session options.
 * Returns a function that the SDK calls instead of child_process.spawn.
 */
export function createTuiSpawn() {
  const sdkSocketPath = `/tmp/claude-sdk-ipc-${state.SESSION_ID || randomUUID()}.sock`;

  return {
    sdkSocketPath,
    spawnClaudeCodeProcess: (config: SpawnConfig): ChildProcess => {
      return spawnInteractiveInTmux(config, sdkSocketPath);
    },
  };
}

function spawnInteractiveInTmux(config: SpawnConfig, sdkSocketPath: string): ChildProcess {
  const { cwd, env, signal } = config;

  // Build interactive Claude Code args (NOT stream-json)
  const claudeArgs = [
    "--dangerously-skip-permissions",
    "--remote-control",
  ];
  if (state.MODEL) claudeArgs.push("--model", state.MODEL);
  if (state.SYSTEM_PROMPT) claudeArgs.push("--system-prompt", state.SYSTEM_PROMPT);
  else if (state.APPEND_SYSTEM_PROMPT) claudeArgs.push("--append-system-prompt", state.APPEND_SYSTEM_PROMPT);
  if (state.WORKSPACE) claudeArgs.push("--add-dir", state.WORKSPACE);

  const executable = PATCHED_CLI_PATH ? "bun" : "claude";
  const execArgs = PATCHED_CLI_PATH
    ? [PATCHED_CLI_PATH, ...claudeArgs]
    : claudeArgs;

  // Build env for Claude Code — no OAuth token, user logs in interactively
  const baseEnv = buildClaudeChildEnv();
  const childEnv: Record<string, string> = {
    ...env,
    ...baseEnv,
    TERM: "xterm-256color",
    CLAUDE_SDK_IPC_SOCKET: sdkSocketPath,
    ENABLE_TOOL_SEARCH: "false",
  };
  // Remove OAuth token so Claude Code prompts for interactive login
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

  // Prepare Claude config (skip onboarding, trust workspace)
  const home = childEnv.HOME || "/home/runner";
  prepareClaudeConfig(home);

  // Build the full command string for tmux
  const claudeCmd = [executable, ...execArgs].map(a => a.includes(" ") ? `"${a}"` : a).join(" ");

  logger.info("runner.tui-spawn", "spawning_interactive_in_tmux", {
    session_id: state.SESSION_ID,
    claude_args: claudeArgs,
    sdk_socket: sdkSocketPath,
    tmux_session: "claude",
  });

  // Kill existing tmux sleep process and replace with Claude Code.
  // -c sets the working directory for the new pane process.
  const tmuxProc = spawn("tmux", [
    "respawn-pane", "-t", "claude", "-k", "-c", cwd,
    "--", "bash", "-c", claudeCmd,
  ], {
    cwd,
    env: childEnv,
    stdio: ["ignore", "ignore", "ignore"],
  });

  // Create the fake ChildProcess that bridges to sdk-ipc socket
  return createSocketBridge(sdkSocketPath, signal, tmuxProc);
}

/**
 * Creates a fake ChildProcess that:
 * - stdout: emits NDJSON events from the sdk-ipc socket
 * - stdin: parses NDJSON from the SDK and forwards to the socket
 * - Emits 'exit' when the tmux process ends
 */
function createSocketBridge(socketPath: string, signal: AbortSignal, tmuxProc: ChildProcess): ChildProcess {
  const emitter = new EventEmitter();

  // Create readable stdout (SDK reads from this)
  const stdout = new Readable({
    read() {},
  });

  // Create writable stdin (SDK writes to this)
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      // Forward SDK's stream-json input to the socket
      if (socket && !socket.destroyed) {
        const lines = chunk.toString().split("\n").filter((l: string) => l.trim());
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            // Convert SDK stream-json format to sdk-ipc format
            if (msg.type === "user" || msg.message) {
              socket.write(JSON.stringify({
                type: "user",
                message: msg.message || msg,
                uuid: msg.uuid || randomUUID(),
              }) + "\n");
            }
          } catch {
            // Not JSON, ignore
          }
        }
      }
      callback();
    },
  });

  let socket: Socket | null = null;
  let exited = false;

  // Connect to sdk-ipc socket with retry
  const connectStart = Date.now();
  const tryConnect = () => {
    if (exited || signal.aborted) return;
    if (Date.now() - connectStart > SOCKET_CONNECT_TIMEOUT_MS) {
      logger.error("runner.tui-spawn", "socket_connect_timeout", { path: socketPath });
      stdout.push(JSON.stringify({ type: "system", subtype: "error", error: "SDK IPC socket connect timeout" }) + "\n");
      return;
    }

    const conn = createConnection(socketPath);
    conn.on("connect", () => {
      socket = conn;
      logger.info("runner.tui-spawn", "sdk_ipc_connected", { path: socketPath });

      // Forward socket data to stdout (SDK reads NDJSON from here)
      let buf = "";
      conn.on("data", (data) => {
        buf += data.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) {
            stdout.push(line + "\n");
          }
        }
      });

      conn.on("close", () => {
        socket = null;
        if (!exited) {
          exited = true;
          stdout.push(null); // EOF
          emitter.emit("exit", 0, null);
        }
      });

      conn.on("error", (err) => {
        logger.warn("runner.tui-spawn", "socket_error", { error: err.message });
      });
    });

    conn.on("error", () => {
      // Retry
      setTimeout(tryConnect, SOCKET_CONNECT_INTERVAL_MS);
    });
  };

  // Start connecting after a brief delay (let Claude Code start)
  setTimeout(tryConnect, 500);

  // Handle tmux process exit
  tmuxProc.on("exit", (code, sig) => {
    if (!exited) {
      exited = true;
      socket?.destroy();
      stdout.push(null);
      emitter.emit("exit", code, sig);
    }
  });

  // Handle abort
  signal.addEventListener("abort", () => {
    socket?.destroy();
    if (!exited) {
      exited = true;
      stdout.push(null);
      emitter.emit("exit", null, "SIGTERM");
    }
  });

  // Return a ChildProcess-like object
  const fakeProcess = Object.assign(emitter, {
    stdin,
    stdout,
    stderr: null,
    get killed() { return exited; },
    get exitCode() { return exited ? 0 : null; },
    kill: () => {
      socket?.destroy();
      spawn("tmux", ["kill-session", "-t", "claude"], { stdio: "ignore" });
      if (!exited) {
        exited = true;
        stdout.push(null);
        emitter.emit("exit", null, "SIGTERM");
      }
      return true;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  });

  return fakeProcess as unknown as ChildProcess;
}

/** Pre-create or patch .claude.json to skip onboarding + trust dialogs. */
function prepareClaudeConfig(home: string): void {
  const claudeJsonPath = join(home, ".claude.json");
  const workspacePath = state.WORKSPACE || "/workspace";

  let config: Record<string, any> = {};
  if (existsSync(claudeJsonPath)) {
    try {
      config = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    } catch {
      config = {};
    }
  } else {
    const backupDir = join(home, ".claude", "backups");
    try {
      if (existsSync(backupDir)) {
        const backups = readdirSync(backupDir)
          .filter(f => f.startsWith(".claude.json.backup."))
          .sort()
          .reverse();
        if (backups.length > 0) {
          copyFileSync(join(backupDir, backups[0]), claudeJsonPath);
          try { config = JSON.parse(readFileSync(claudeJsonPath, "utf8")); } catch { config = {}; }
        }
      }
    } catch {}
  }

  config.theme = config.theme || "dark";
  config.hasCompletedOnboarding = true;
  config.hasSeenOnboardingTip = true;
  config.projects = config.projects || {};
  config.projects[workspacePath] = config.projects[workspacePath] || {};
  config.projects[workspacePath].hasTrustDialogAccepted = true;

  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(claudeJsonPath, JSON.stringify(config));

  // Workspace trust settings
  const projectDir = join(home, ".claude", "projects", `-${workspacePath.replace(/\//g, "-").replace(/^-/, "")}`);
  try {
    mkdirSync(projectDir, { recursive: true });
    const trustFile = join(projectDir, "settings.json");
    if (!existsSync(trustFile)) {
      writeFileSync(trustFile, JSON.stringify({ hasTrustDialogAccepted: true }));
    }
  } catch {}
}

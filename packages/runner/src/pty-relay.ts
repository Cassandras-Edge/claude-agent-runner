import WebSocket from "ws";
import { execFileSync } from "child_process";
import { logger } from "./logger.js";
import { state } from "./state.js";

/**
 * Attach PTY byte relay: forward PTY stdout/stderr to the orchestrator WS
 * as base64-encoded binary frames, and route pty_input messages from the
 * orchestrator to the PTY's stdin.
 */
export function attachPtyRelay(ws: WebSocket): void {
  const proc = state.ptyProcess;
  if (!proc) {
    logger.warn("runner.pty-relay", "no_process", { session_id: state.SESSION_ID });
    return;
  }

  // PTY stdout → WS (base64 frames)
  proc.stdout?.on("data", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "pty_data",
        session_id: state.SESSION_ID,
        data: data.toString("base64"),
      }));
    }
  });

  // PTY stderr → WS (same format, different subtype for debugging)
  proc.stderr?.on("data", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "pty_data",
        session_id: state.SESSION_ID,
        data: data.toString("base64"),
        stderr: true,
      }));
    }
  });

  // PTY exit → WS notification
  proc.on("exit", (code, signal) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "pty_exit",
        session_id: state.SESSION_ID,
        exit_code: code,
        signal,
      }));
    }
  });

  logger.info("runner.pty-relay", "attached", { session_id: state.SESSION_ID });
}

/**
 * Handle inbound PTY data from the orchestrator (keystrokes + resize).
 * Called from the WS message handler when type === "pty_input" or "pty_resize".
 */
export function handlePtyInput(msg: { data?: string; type?: string; cols?: number; rows?: number }): void {
  const proc = state.ptyProcess;
  if (!proc || !proc.stdin) return;

  // Resize event — find the PTY device and use stty to resize it,
  // then SIGWINCH the process so the TUI re-renders.
  if (msg.type === "pty_resize" && msg.cols && msg.rows) {
    const pid = proc.pid;
    if (pid) {
      try {
        // Find the child's PTY device (e.g. /dev/pts/0)
        const ptyDev = findChildPty(pid);
        if (ptyDev) {
          execFileSync("stty", ["cols", String(msg.cols), "rows", String(msg.rows)], {
            stdio: ["pipe", "pipe", "pipe"],
            // Redirect stdin from the PTY device
            input: "",
            env: { ...process.env, TERM: "xterm-256color" },
          });
          // Actually need to run stty with the PTY as stdin — use sh -c
          execFileSync("sh", ["-c", `stty cols ${msg.cols} rows ${msg.rows} < ${ptyDev}`], {
            stdio: ["pipe", "pipe", "pipe"],
          });
        }
        // SIGWINCH the process group so the TUI re-renders
        process.kill(-pid, "SIGWINCH");
      } catch (err) {
        // Silently ignore — resize is best-effort
        logger.debug("runner.pty-relay", "resize_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return;
  }

  // Raw keystroke data (base64-encoded)
  if (msg.data) {
    const raw = Buffer.from(msg.data, "base64");
    proc.stdin.write(raw);
  }
}

/**
 * Find the PTY device used by a child process.
 * Reads /proc/<pid>/fd/0 symlink to find the PTY (e.g. /dev/pts/0).
 */
function findChildPty(parentPid: number): string | null {
  try {
    const { readdirSync, readlinkSync } = require("fs");
    // Find child processes (the bun process inside script)
    const pids = readdirSync("/proc").filter((f: string) => /^\d+$/.test(f));
    for (const childPid of pids) {
      try {
        const link = readlinkSync(`/proc/${childPid}/fd/0`);
        if (link.startsWith("/dev/pts/")) {
          return link;
        }
      } catch {}
    }
  } catch {}
  return null;
}

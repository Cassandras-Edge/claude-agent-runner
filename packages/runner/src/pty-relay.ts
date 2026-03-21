import WebSocket from "ws";
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
 * Called from the WS message handler when type === "pty_input".
 */
export function handlePtyInput(msg: { data?: string; type?: string; cols?: number; rows?: number }): void {
  const proc = state.ptyProcess;
  if (!proc || !proc.stdin) return;

  // Resize event — send xterm resize escape sequence to the PTY,
  // then SIGWINCH the process group so the TUI re-renders.
  if (msg.type === "pty_resize" && msg.cols && msg.rows) {
    // Send xterm resize sequence
    proc.stdin!.write(`\x1b[8;${msg.rows};${msg.cols}t`);
    // SIGWINCH the process group
    const pid = proc.pid;
    if (pid) {
      try { process.kill(-pid, "SIGWINCH"); } catch {}
    }
    logger.debug("runner.pty-relay", "resize", { cols: msg.cols, rows: msg.rows });
    return;
  }

  // Raw keystroke data (base64-encoded)
  if (msg.data) {
    const raw = Buffer.from(msg.data, "base64");
    proc.stdin.write(raw);
  }
}

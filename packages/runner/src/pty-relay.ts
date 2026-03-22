import WebSocket from "ws";
import { logger } from "./logger.js";
import { state } from "./state.js";

/**
 * Attach PTY byte relay: forward PTY output to the orchestrator WS
 * as base64-encoded frames, and route input/resize from the orchestrator
 * to the PTY.
 */
export function attachPtyRelay(ws: WebSocket): void {
  const ptyHandle = state.ptyHandle;
  if (!ptyHandle) {
    logger.warn("runner.pty-relay", "no_pty_handle", { session_id: state.SESSION_ID });
    return;
  }

  // PTY output → WS (base64 frames)
  ptyHandle.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "pty_data",
        session_id: state.SESSION_ID,
        data: Buffer.from(data).toString("base64"),
      }));
    }
  });

  // PTY exit → WS notification
  ptyHandle.onExit(({ exitCode, signal }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "pty_exit",
        session_id: state.SESSION_ID,
        exit_code: exitCode,
        signal,
      }));
    }
  });

  logger.info("runner.pty-relay", "attached", { session_id: state.SESSION_ID });
}

/**
 * Handle inbound PTY data from the orchestrator (keystrokes + resize).
 */
export function handlePtyInput(msg: { data?: string; type?: string; cols?: number; rows?: number }): void {
  const ptyHandle = state.ptyHandle;
  if (!ptyHandle) return;

  // Resize — node-pty handles this natively
  if (msg.type === "pty_resize" && msg.cols && msg.rows) {
    ptyHandle.resize(msg.cols, msg.rows);
    logger.debug("runner.pty-relay", "resize", { cols: msg.cols, rows: msg.rows });
    return;
  }

  // Raw keystroke data (base64-encoded)
  if (msg.data) {
    const raw = Buffer.from(msg.data, "base64");
    ptyHandle.write(raw.toString());
  }
}

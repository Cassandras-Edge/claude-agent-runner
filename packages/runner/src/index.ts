import WebSocket from "ws";
import { existsSync, mkdirSync } from "fs";
import type { OrchestratorCommand } from "@bugcat/claude-agent-runner-shared";
import { ORCHESTRATOR_URL, initConfig } from "./config.js";
import { handleMessage, preloadWarmSession } from "./command-handler.js";
import { logger } from "./logger.js";
import { cloneRepo, prepareVault } from "./source-prep.js";
import { attachPtyRelay, handlePtyInput } from "./pty-relay.js";
import { state } from "./state.js";

initConfig();

function connect(): void {
  logger.info("runner.ws", "connecting", { orchestrator_url: ORCHESTRATOR_URL, session_id: state.SESSION_ID });
  const ws = new WebSocket(ORCHESTRATOR_URL!);

  ws.on("open", async () => {
    logger.info("runner.ws", "connected", { session_id: state.SESSION_ID });

    try {
      if (!state.setupCompleted) {
        if (state.REPO) {
          ws.send(JSON.stringify({ type: "status", session_id: state.SESSION_ID, status: "cloning" }));
          cloneRepo();
        } else if (state.VAULT) {
          prepareVault();
        }

        if (!existsSync(state.WORKSPACE)) {
          mkdirSync(state.WORKSPACE, { recursive: true });
        }
        process.chdir(state.WORKSPACE);

        state.setupCompleted = true;
      }

      await preloadWarmSession(ws);

      // Attach PTY relay if running in PTY mode
      if (state.ptyMode && state.ptyHandle) {
        attachPtyRelay(ws);
        ws.send(JSON.stringify({
          type: "status",
          session_id: state.SESSION_ID,
          status: "ready",
          pty_mode: true,
          rc_session_url: state.rcSessionUrl,
        }));
      } else {
        ws.send(JSON.stringify({ type: "status", session_id: state.SESSION_ID, status: "ready" }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("runner.ws", "setup_failed", { session_id: state.SESSION_ID, error: message });
      ws.send(JSON.stringify({ type: "error", session_id: state.SESSION_ID, code: "clone_failed", message }));
      ws.close();
      process.exit(1);
    }
  });

  ws.on("message", async (data) => {
    let msg: OrchestratorCommand;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      logger.warn("runner.ws", "invalid_json_from_orchestrator", { session_id: state.SESSION_ID });
      return;
    }

    // Route PTY input/resize messages directly to the PTY relay
    if (((msg as any).type === "pty_input" || (msg as any).type === "pty_resize") && state.ptyMode) {
      handlePtyInput(msg as any);
      return;
    }

    await handleMessage(ws, msg);
  });

  ws.on("close", () => {
    logger.warn("runner.ws", "disconnected", { session_id: state.SESSION_ID, reconnect_delay_ms: 3000 });
    setTimeout(connect, 3000);
  });

  ws.on("error", (err) => {
    logger.error("runner.ws", "websocket_error", {
      session_id: state.SESSION_ID,
      error: err.message,
    });
  });
}

logger.info("runner.start", "starting_runner", { session_id: state.SESSION_ID });
connect();

import WebSocket from "ws";
import type { SDKSession } from "@anthropic-ai/claude-agent-sdk";
import { serializeEvent } from "./serialize.js";
import { logger } from "./logger.js";

export interface DrainResult {
  success: boolean;
  /** The SDK result event from the completed turn */
  result?: any;
  /** Error message if the drain failed */
  error?: string;
}

/**
 * Drains a background SDK session's stream to completion.
 *
 * Keeps iterating the session's event stream until a `result` event arrives
 * or an error occurs. Optionally forwards events to the orchestrator tagged
 * as background events.
 */
export async function drainBackground(
  session: SDKSession,
  ws: WebSocket,
  sessionId: string,
  taskId: string,
): Promise<DrainResult> {
  try {
    let result = null;
    for await (const event of session.stream()) {
      const eventType = (event as any).type;

      // Forward as background-tagged events (orchestrator can choose to suppress or show)
      const serialized = serializeEvent(event as any);
      if (serialized && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "event",
          session_id: sessionId,
          event: serialized,
          background: true,
          task_id: taskId,
        }));
      }

      logger.debug("runner.background", "bg_drain_event", {
        session_id: sessionId,
        task_id: taskId,
        event_type: eventType,
      });

      if (eventType === "result") {
        result = event;
        break;
      }
    }

    logger.info("runner.background", "bg_drain_complete", {
      session_id: sessionId,
      task_id: taskId,
      has_result: !!result,
    });

    return { success: true, result };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("runner.background", "bg_drain_failed", {
      session_id: sessionId,
      task_id: taskId,
      error: errorMsg,
    });
    return { success: false, error: errorMsg };
  }
}

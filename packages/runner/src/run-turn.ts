import WebSocket from "ws";
import { unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";
import { FIRST_EVENT_TIMEOUT_MS } from "./config.js";
import { drainBackground } from "./background-drainer.js";
import { buildZeroEventError } from "./helpers.js";
import { logger } from "./logger.js";
import { mergeBackResult } from "./merge-back.js";
import { buildSessionOptions, createOrResumeSession, ensureIpcConnected } from "./session-lifecycle.js";
import { serializeEvent } from "./serialize.js";
import { state } from "./state.js";

export async function runTurn(
  ws: WebSocket,
  message: string | any[],
  overrides?: {
    model?: string;
    maxTurns?: number;
    maxThinkingTokens?: number;
    requestId?: string;
    traceId?: string;
    forceCompact?: boolean;
    compactInstructionsOverride?: string;
  },
): Promise<void> {
  const requestId = overrides?.requestId;
  const traceId = overrides?.traceId;

  logger.info("runner.agent", "turn_start", {
    session_id: state.SESSION_ID,
    request_id: requestId,
    trace_id: traceId,
    model: overrides?.model || state.MODEL,
    has_session: Boolean(state.session),
  });

  if (!state.session) {
    try {
      state.session = await createOrResumeSession(ws);
      logger.info("runner.session", "session_created");
    } catch (err) {
      logger.error("runner.session", "session_create_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  if (overrides?.model && overrides.model !== state.MODEL) {
    try {
      await (state.session as any).setModel(overrides.model);
    } catch {}
  }

  if (overrides?.maxThinkingTokens !== undefined && overrides.maxThinkingTokens > 0) {
    try {
      await (state.session as any).setMaxThinkingTokens(overrides.maxThinkingTokens);
    } catch {}
  }

  if (Array.isArray(message)) {
    await state.session.send({
      type: "user",
      message: { role: "user", content: message },
      parent_tool_use_id: null,
      session_id: state.sdkSessionId || "",
    } as any);
  } else {
    await state.session.send(message);
  }

  let eventCount = 0;
  let firstEventTimeoutTriggered = false;
  const firstEventTimer = setTimeout(() => {
    firstEventTimeoutTriggered = true;
    logger.error("runner.agent", "first_event_timeout", {
      session_id: state.SESSION_ID,
      timeout_ms: FIRST_EVENT_TIMEOUT_MS,
    });
    state.session?.close();
    state.session = null;
  }, FIRST_EVENT_TIMEOUT_MS);

  try {
    for await (const event of state.session.stream()) {
      if (eventCount === 0) {
        clearTimeout(firstEventTimer);
      }

      eventCount++;

      if (!state.sdkSessionId && "session_id" in event && (event as any).session_id) {
        state.sdkSessionId = (event as any).session_id;

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "session_init",
            session_id: state.SESSION_ID,
            sdk_session_id: state.sdkSessionId,
            request_id: requestId,
            trace_id: traceId,
          }));
        }
        logger.info("runner.agent", "session_id_acquired", {
          runner_session_id: state.SESSION_ID,
          sdk_session_id: state.sdkSessionId,
          request_id: requestId,
        });

        ensureIpcConnected().catch(() => {});
      }

      const serialized = serializeEvent(event as any);
      if (serialized && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "event",
          session_id: state.SESSION_ID,
          event: serialized,
          request_id: requestId,
          trace_id: traceId,
        }));
      }

      logger.debug("runner.agent", "sdk_event", {
        session_id: state.SESSION_ID,
        event_type: (event as any).type,
        event_subtype: (event as any).subtype,
      });

      if ((event as any).type === "result" && (event as any).modelUsage && ws.readyState === WebSocket.OPEN) {
        const modelEntries = Object.values((event as any).modelUsage as Record<string, any>);
        const contextWindow = modelEntries[0]?.contextWindow ?? 0;
        if (contextWindow > 0) {
          ws.send(JSON.stringify({
            type: "context_state",
            session_id: state.SESSION_ID,
            context_tokens: contextWindow,
            compacted: overrides?.forceCompact ?? false,
            request_id: requestId,
            trace_id: traceId,
          }));
        }
      }

      if ((event as any).type === "system" && (event as any).subtype === "compact_boundary" && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "context_state",
          session_id: state.SESSION_ID,
          context_tokens: (event as any).compact_metadata?.pre_tokens ?? 0,
          compacted: true,
          request_id: requestId,
          trace_id: traceId,
        }));
      }

      if ((event as any).type === "result") {
        logger.info("runner.agent", "result_received", {
          session_id: state.SESSION_ID,
          sdk_session_id: state.sdkSessionId,
          result_type: (event as any).subtype,
        });
        break;
      }

      if (state.pendingSteer) {
        logger.info("runner.agent", "stream_interrupted_for_steer", {
          session_id: state.SESSION_ID,
        });
        break;
      }

      if (state.pendingForkAndSteer) {
        logger.info("runner.agent", "stream_interrupted_for_fork_and_steer", {
          session_id: state.SESSION_ID,
        });
        break;
      }
    }
  } catch (iterErr) {
    if (firstEventTimeoutTriggered && eventCount === 0) {
      throw new Error(buildZeroEventError(
        "Timed out waiting for first SDK event",
        overrides?.model || state.MODEL,
        overrides?.maxTurns ?? state.MAX_TURNS,
        state.WORKSPACE,
        [],
        [],
      ));
    }
    logger.error("runner.agent", "sdk_iteration_error", {
      session_id: state.SESSION_ID,
      error: iterErr instanceof Error ? iterErr.message : String(iterErr),
    });
    throw iterErr;
  } finally {
    clearTimeout(firstEventTimer);
  }

  if (eventCount === 0) {
    const reason = firstEventTimeoutTriggered
      ? "Timed out waiting for first SDK event"
      : "SDK query completed with zero events";
    throw new Error(buildZeroEventError(
      reason,
      overrides?.model || state.MODEL,
      overrides?.maxTurns ?? state.MAX_TURNS,
      state.WORKSPACE,
      [],
      [],
    ));
  }

  logger.info("runner.agent", "turn_complete", {
    session_id: state.SESSION_ID,
    sdk_session_id: state.sdkSessionId,
    event_count: eventCount,
  });
}

export async function maybeHandleForkAndSteer(ws: WebSocket): Promise<boolean> {
  if (!state.pendingForkAndSteer) return false;

  const forkReq = state.pendingForkAndSteer;
  state.pendingForkAndSteer = null;

  logger.info("runner.ws", "fork_and_steer_executing", {
    session_id: state.SESSION_ID,
    request_id: forkReq.requestId,
  });

    const taskId = `fas_${globalThis.crypto.randomUUID().replace(/-/g, "").substring(0, 8)}`;
  if (state.session) {
    const bgDrain = drainBackground(state.session, ws, state.SESSION_ID, taskId);
    state.backgroundSessions.set(taskId, {
      sdkSessionId: state.sdkSessionId!,
      taskId,
      toolUseSummary: "fork-and-steer background",
      drainPromise: bgDrain,
    });

    bgDrain.then(async (result) => {
      logger.info("runner.background", "bg_complete", {
        session_id: state.SESSION_ID,
        task_id: taskId,
        success: result.success,
      });

      if (state.ipc?.isConnected) {
        await mergeBackResult(state.ipc, result, taskId, state.SESSION_ID);
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "background_complete",
          session_id: state.SESSION_ID,
          task_id: taskId,
          success: result.success,
          error: result.error,
        }));
      }

      state.backgroundSessions.delete(taskId);
    }).catch((err) => {
      logger.error("runner.background", "bg_merge_failed", {
        session_id: state.SESSION_ID,
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      state.backgroundSessions.delete(taskId);
    });
  }

  try {
    const oldSdkSessionId = state.sdkSessionId!;
    const oldSocketPath = state.MEM_SOCKET_PATH;
    state.MEM_SOCKET_PATH = `/tmp/claude-mem-${globalThis.crypto.randomUUID().replace(/-/g, "").substring(0, 8)}.sock`;
    logger.info("runner.ws", "fork_new_socket_path", {
      session_id: state.SESSION_ID,
      old_socket: oldSocketPath,
      new_socket: state.MEM_SOCKET_PATH,
    });

    state.session = await unstable_v2_resumeSession(oldSdkSessionId, {
      ...buildSessionOptions(false, ws),
      forkSession: true,
    } as any);

    logger.info("runner.ws", "forked_session_created", {
      session_id: state.SESSION_ID,
      old_sdk_session: oldSdkSessionId,
      task_id: taskId,
    });

    if (state.ipc) {
      state.ipc.disconnect();
      state.ipc = null;
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "event",
        session_id: state.SESSION_ID,
        event: {
          type: "system",
          subtype: "fork_and_steer",
          task_id: taskId,
          old_sdk_session: oldSdkSessionId,
        },
        request_id: forkReq.requestId,
        trace_id: forkReq.traceId,
      }));
    }
  } catch (forkErr) {
    logger.error("runner.ws", "fork_and_steer_fork_failed", {
      session_id: state.SESSION_ID,
      error: forkErr instanceof Error ? forkErr.message : String(forkErr),
    });
    state.pendingSteer = {
      message: forkReq.message,
      content: forkReq.content,
      model: forkReq.model,
      maxTurns: forkReq.maxTurns,
      requestId: forkReq.requestId,
      traceId: forkReq.traceId,
    };
    return false;
  }

  return true;
}

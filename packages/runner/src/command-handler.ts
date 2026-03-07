import WebSocket from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync } from "fs";
import type {
  ContextOperation,
  OrchestratorCommand,
  OrchestratorForkAndSteerCommand,
  OrchestratorPermissionResponseCommand,
} from "@bugcat/claude-agent-runner-shared";
import { executeContextOp, emitSnapshot } from "./context-ops.js";
import { PATCHED_CLI_PATH } from "./config.js";
import { logger, runWithLogContext } from "./logger.js";
import { createOrResumeSession } from "./session-lifecycle.js";
import { cloneRepo, stopVaultSync, syncVault } from "./source-prep.js";
import { maybeHandleForkAndSteer, runTurn } from "./run-turn.js";
import { state } from "./state.js";

function sendBusy(ws: WebSocket, requestId?: string, traceId?: string): void {
  ws.send(JSON.stringify({
    type: "status",
    session_id: state.SESSION_ID,
    status: "busy",
    request_id: requestId,
    trace_id: traceId,
  }));
}

function sendReady(ws: WebSocket, requestId?: string, traceId?: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "status",
      session_id: state.SESSION_ID,
      status: "ready",
      request_id: requestId,
      trace_id: traceId,
    }));
  }
}

function sendExecutionError(ws: WebSocket, requestId?: string, traceId?: string, errorMsg?: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "event",
      session_id: state.SESSION_ID,
      request_id: requestId,
      trace_id: traceId,
      event: {
        type: "result",
        subtype: "error_during_execution",
        result: "",
        errors: errorMsg ? [errorMsg] : [],
        usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 },
      },
    }));
  }
}

export async function handleMessage(ws: WebSocket, msg: OrchestratorCommand): Promise<void> {
  if (msg.type === "message") {
    const requestId = msg.request_id;
    const traceId = msg.trace_id;
    return runWithLogContext({ sessionId: state.SESSION_ID, requestId, traceId }, async () => {
      logger.info("runner.ws", "message_received", {
        session_id: state.SESSION_ID,
        message_preview: msg.message?.slice(0, 120),
        model: msg.model,
        request_id: requestId,
        trace_id: traceId,
      });
      state.isBusy = true;
      sendBusy(ws, requestId, traceId);

      let useForceCompact = state.forceCompactOnNextQuery;
      let useCompactInstructions = state.pendingCompactInstructions;
      state.forceCompactOnNextQuery = false;
      state.pendingCompactInstructions = undefined;

      let currentMessage: string | any = msg.content || msg.message;
      let currentModel = msg.model;
      let currentMaxTurns = msg.maxTurns;
      let currentMaxThinkingTokens = msg.maxThinkingTokens ?? (globalThis as any).__runnerMaxThinkingTokensOverride;
      let currentRequestId = requestId;
      let currentTraceId = traceId;

      while (true) {
        try {
          await runTurn(ws, currentMessage, {
            model: currentModel,
            maxTurns: currentMaxTurns,
            maxThinkingTokens: currentMaxThinkingTokens,
            requestId: currentRequestId,
            traceId: currentTraceId,
            forceCompact: useForceCompact,
            compactInstructionsOverride: useCompactInstructions,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (!state.pendingSteer) {
            logger.error("runner.ws", "agent_execution_failed", { session_id: state.SESSION_ID, error: errorMsg });
            sendExecutionError(ws, currentRequestId, currentTraceId, errorMsg);
          } else {
            logger.info("runner.ws", "turn_interrupted_for_steer", { session_id: state.SESSION_ID });
          }
        }

        if (state.pendingForkAndSteer) {
          const forkReq = state.pendingForkAndSteer;
          const handled = await maybeHandleForkAndSteer(ws);
          if (handled && forkReq) {
            currentMessage = forkReq.content || forkReq.message;
            currentModel = forkReq.model;
            currentMaxTurns = forkReq.maxTurns;
            currentMaxThinkingTokens = forkReq.maxThinkingTokens;
            currentRequestId = forkReq.requestId;
            currentTraceId = forkReq.traceId;
            useForceCompact = false;
            useCompactInstructions = undefined;
            continue;
          }
        }

        if (!state.pendingSteer) break;

        const steer = state.pendingSteer;
        state.pendingSteer = null;

        // Empty steer = cancel (interrupt without sending a follow-up message)
        if (!steer.message && !steer.content) {
          logger.info("runner.ws", "steer_cancel", { session_id: state.SESSION_ID, request_id: steer.requestId });
          if (state.session) {
            try { await (state.session as any).query.interrupt(); } catch {}
          }
          break;
        }

        logger.info("runner.ws", "steer_executing", {
          session_id: state.SESSION_ID,
          request_id: steer.requestId,
          operations_count: steer.operations?.length ?? 0,
        });

        if (steer.operations && steer.operations.length > 0) {
          for (const op of steer.operations) {
            try {
              await executeContextOp(op);
              logger.debug("runner.ws", "steer_op_executed", { session_id: state.SESSION_ID, op: op.op });
            } catch (opErr) {
              const opErrMsg = opErr instanceof Error ? opErr.message : String(opErr);
              logger.error("runner.ws", "steer_op_failed", { session_id: state.SESSION_ID, op: op.op, error: opErrMsg });
            }
          }
        }

        await emitSnapshot(ws, "steer", steer.requestId);
        if (ws.readyState === WebSocket.OPEN) {
          sendBusy(ws, steer.requestId, steer.traceId);
        }

        currentMessage = steer.content || steer.message;
        currentModel = steer.model;
        currentMaxTurns = steer.maxTurns;
        currentMaxThinkingTokens = steer.maxThinkingTokens;
        currentRequestId = steer.requestId;
        currentTraceId = steer.traceId;
        useForceCompact = steer.compact ?? false;
        useCompactInstructions = steer.compactInstructions;
      }

      state.isBusy = false;
      sendReady(ws, currentRequestId, currentTraceId);
    });
  }

  if (msg.type === "compact") {
    state.forceCompactOnNextQuery = true;
    state.pendingCompactInstructions = msg.custom_instructions;
    logger.info("runner.ws", "compact_scheduled", {
      session_id: state.SESSION_ID,
      has_custom_instructions: Boolean(state.pendingCompactInstructions),
      request_id: msg.request_id,
    });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "status",
        session_id: state.SESSION_ID,
        status: "ready",
        request_id: msg.request_id,
      }));
    }
    return;
  }

  if (msg.type === "steer") {
    const steerMsg = msg;
    const steerRequestId = steerMsg.request_id;
    const steerTraceId = steerMsg.trace_id;

    logger.info("runner.ws", "steer_received", {
      session_id: state.SESSION_ID,
      is_busy: state.isBusy,
      message_preview: steerMsg.message?.slice(0, 120),
      operations_count: steerMsg.operations?.length ?? 0,
      request_id: steerRequestId,
    });

    if (state.isBusy) {
      state.pendingSteer = {
        message: steerMsg.message,
        content: steerMsg.content,
        model: steerMsg.model,
        maxTurns: steerMsg.maxTurns,
        maxThinkingTokens: steerMsg.maxThinkingTokens,
        requestId: steerRequestId,
        traceId: steerTraceId,
        compact: steerMsg.compact,
        compactInstructions: steerMsg.compact_instructions,
        operations: steerMsg.operations,
      };
      if (state.session) {
        try { await (state.session as any).query.interrupt(); } catch {}
      }
    } else {
      // Empty steer while idle = no-op cancel
      if (!steerMsg.message && !steerMsg.content) {
        logger.info("runner.ws", "steer_cancel_idle", { session_id: state.SESSION_ID, request_id: steerRequestId });
        sendReady(ws, steerRequestId, steerTraceId);
        return;
      }

      return runWithLogContext({ sessionId: state.SESSION_ID, requestId: steerRequestId, traceId: steerTraceId }, async () => {
        state.isBusy = true;
        sendBusy(ws, steerRequestId, steerTraceId);

        if (steerMsg.operations && steerMsg.operations.length > 0) {
          for (const op of steerMsg.operations as ContextOperation[]) {
            try {
              await executeContextOp(op);
            } catch (opErr) {
              const opErrMsg = opErr instanceof Error ? opErr.message : String(opErr);
              logger.error("runner.ws", "steer_idle_op_failed", { session_id: state.SESSION_ID, op: op.op, error: opErrMsg });
            }
          }
        }

        await emitSnapshot(ws, "steer", steerRequestId);

        try {
          await runTurn(ws, steerMsg.content || steerMsg.message, {
            model: steerMsg.model,
            maxTurns: steerMsg.maxTurns,
            maxThinkingTokens: steerMsg.maxThinkingTokens,
            requestId: steerRequestId,
            traceId: steerTraceId,
            forceCompact: steerMsg.compact ?? false,
            compactInstructionsOverride: steerMsg.compact_instructions,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error("runner.ws", "steer_idle_agent_failed", { session_id: state.SESSION_ID, error: errorMsg });
          sendExecutionError(ws, steerRequestId, steerTraceId, errorMsg);
        }

        state.isBusy = false;
        sendReady(ws, steerRequestId, steerTraceId);
      });
    }
    return;
  }

  if (msg.type === "fork_and_steer") {
    const fasMsg = msg as OrchestratorForkAndSteerCommand;
    const fasRequestId = fasMsg.request_id;
    const fasTraceId = fasMsg.trace_id;

    logger.info("runner.ws", "fork_and_steer_received", {
      session_id: state.SESSION_ID,
      is_busy: state.isBusy,
      message_preview: fasMsg.message?.slice(0, 120),
      request_id: fasRequestId,
    });

    if (state.isBusy) {
      state.pendingForkAndSteer = {
        message: fasMsg.message,
        content: fasMsg.content,
        model: fasMsg.model,
        maxTurns: fasMsg.maxTurns,
        maxThinkingTokens: fasMsg.maxThinkingTokens,
        requestId: fasRequestId,
        traceId: fasTraceId,
      };
      if (state.session) {
        try { await (state.session as any).query.interrupt(); } catch {}
      }
    } else {
      logger.info("runner.ws", "fork_and_steer_idle_fallback", { session_id: state.SESSION_ID });
      return runWithLogContext({ sessionId: state.SESSION_ID, requestId: fasRequestId, traceId: fasTraceId }, async () => {
        state.isBusy = true;
        sendBusy(ws, fasRequestId, fasTraceId);
        try {
          await runTurn(ws, fasMsg.content || fasMsg.message, {
            model: fasMsg.model,
            maxTurns: fasMsg.maxTurns,
            maxThinkingTokens: fasMsg.maxThinkingTokens,
            requestId: fasRequestId,
            traceId: fasTraceId,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error("runner.ws", "fork_and_steer_idle_failed", { session_id: state.SESSION_ID, error: errorMsg });
          sendExecutionError(ws, fasRequestId, fasTraceId, errorMsg);
        }
        state.isBusy = false;
        sendReady(ws, fasRequestId, fasTraceId);
      });
    }
    return;
  }

  if (msg.type === "context") {
    const requestId = msg.request_id;

    if (state.isBusy) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "context_result",
          session_id: state.SESSION_ID,
          success: false,
          error: "Session is busy",
          request_id: requestId,
        }));
      }
      return;
    }

    try {
      const resultData = await executeContextOp(msg.operation);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "context_result",
          session_id: state.SESSION_ID,
          success: true,
          data: resultData,
          request_id: requestId,
          trace_id: msg.trace_id,
        }));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("runner.ws", "context_operation_failed", { session_id: state.SESSION_ID, error: errorMsg });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "context_result",
          session_id: state.SESSION_ID,
          success: false,
          error: errorMsg,
          request_id: requestId,
        }));
      }
    }
    return;
  }

  if (msg.type === "rewind") {
    const requestId = msg.request_id;

    if (state.isBusy) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "context_result",
          session_id: state.SESSION_ID,
          success: false,
          error: "Session is busy",
          request_id: requestId,
        }));
      }
      return;
    }

    try {
      if (!state.ipc?.isConnected) {
        throw new Error("IPC not connected — cannot rewind");
      }

      const messages = await state.ipc.getMessages();
      const targetUuid = msg.user_message_uuid;
      const targetIdx = messages.findIndex((m: any) => m.uuid === targetUuid);

      if (targetIdx === -1) {
        throw new Error(`Message UUID not found: ${targetUuid}`);
      }

      const removeCount = messages.length - (targetIdx + 1);
      if (removeCount > 0) {
        await state.ipc.splice(targetIdx + 1, removeCount);
      }

      logger.info("runner.ws", "rewind_complete", {
        session_id: state.SESSION_ID,
        target_uuid: targetUuid,
        messages_removed: removeCount,
        request_id: requestId,
      });

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "context_result",
          session_id: state.SESSION_ID,
          success: true,
          data: { messages_removed: removeCount },
          request_id: requestId,
        }));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("runner.ws", "rewind_failed", { session_id: state.SESSION_ID, error: errorMsg });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "context_result",
          session_id: state.SESSION_ID,
          success: false,
          error: errorMsg,
          request_id: requestId,
        }));
      }
    }
    return;
  }

  if (msg.type === "set_options") {
    if (msg.model) {
      state.MODEL = msg.model;
      if (state.session) {
        try { await (state.session as any).query.setModel(msg.model); } catch {}
      }
      logger.info("runner.ws", "model_override_set", { session_id: state.SESSION_ID, model: msg.model });
    }
    if (msg.maxThinkingTokens !== undefined) {
      (globalThis as any).__runnerMaxThinkingTokensOverride = msg.maxThinkingTokens;
      const newThinking = msg.maxThinkingTokens > 0;
      if (newThinking !== state.THINKING) {
        state.THINKING = newThinking;
        if (state.session) {
          state.session.close();
          state.session = null;
          logger.info("runner.ws", "session_closed_for_thinking_change", {
            session_id: state.SESSION_ID,
            thinking: newThinking,
          });
        }
      }
      logger.info("runner.ws", "max_thinking_tokens_override_set", {
        session_id: state.SESSION_ID,
        maxThinkingTokens: msg.maxThinkingTokens,
      });
    }
    if (msg.compact_instructions) {
      state.activeCompactInstructions = msg.compact_instructions;
      logger.info("runner.ws", "compact_instructions_override_set", { session_id: state.SESSION_ID });
    }
    if (msg.permission_mode) {
      const newMode = msg.permission_mode;
      if (newMode !== state.PERMISSION_MODE) {
        state.PERMISSION_MODE = newMode;
        if (state.session) {
          state.session.close();
          state.session = null;
          logger.info("runner.ws", "session_closed_for_permission_mode_change", {
            session_id: state.SESSION_ID,
            new_mode: newMode,
          });
        }
      }
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "status",
        session_id: state.SESSION_ID,
        status: state.isBusy ? "busy" : "ready",
        request_id: msg.request_id,
      }));
    }
    return;
  }

  if (msg.type === "permission_response") {
    const permMsg = msg as OrchestratorPermissionResponseCommand;
    const resolver = state.pendingPermissionRequests.get(permMsg.tool_use_id);
    if (resolver) {
      state.pendingPermissionRequests.delete(permMsg.tool_use_id);
      resolver({
        behavior: permMsg.behavior,
        message: permMsg.message,
        updatedInput: permMsg.updated_input,
      });
      logger.debug("runner.ws", "permission_response_resolved", {
        session_id: state.SESSION_ID,
        tool_use_id: permMsg.tool_use_id,
        behavior: permMsg.behavior,
      });
    } else {
      logger.warn("runner.ws", "permission_response_no_pending_request", {
        session_id: state.SESSION_ID,
        tool_use_id: permMsg.tool_use_id,
      });
    }
    return;
  }

  if (msg.type === "get_commands") {
    const requestId = msg.request_id;
    const traceId = msg.trace_id;
    try {
      const commands = state.session ? await (state.session as any).query.supportedCommands() : [];
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "commands_result",
          session_id: state.SESSION_ID,
          commands: commands.map((c: any) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
          request_id: requestId,
          trace_id: traceId,
        }));
      }
    } catch (err) {
      logger.warn("runner.ws", "get_commands_failed", {
        session_id: state.SESSION_ID,
        error: err instanceof Error ? err.message : String(err),
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "commands_result",
          session_id: state.SESSION_ID,
          commands: [],
          request_id: requestId,
          trace_id: traceId,
        }));
      }
    }
    return;
  }

  if (msg.type === "utility_query") {
    const requestId = msg.request_id;
    const traceId = msg.trace_id;
    logger.info("runner.ws", "utility_query_received", {
      session_id: state.SESSION_ID,
      model: msg.model,
      prompt_preview: msg.prompt?.slice(0, 80),
    });
    (async () => {
      try {
        const response = query({
          prompt: msg.prompt,
          options: {
            cwd: state.WORKSPACE,
            model: msg.model || "haiku",
            systemPrompt: msg.systemPrompt || undefined,
            tools: [],
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            persistSession: false,
            ...(PATCHED_CLI_PATH ? { pathToClaudeCodeExecutable: PATCHED_CLI_PATH, executable: "bun" as const } : {}),
          },
        });

        let text = "";
        for await (const message of response) {
          if ((message as any).type === "assistant" && (message as any).message?.content) {
            for (const block of (message as any).message.content) {
              if ((block as any).type === "text" && (block as any).text) {
                text += (block as any).text;
              }
            }
          }
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "utility_query_result",
            session_id: state.SESSION_ID,
            text,
            request_id: requestId,
            trace_id: traceId,
          }));
        }
      } catch (err) {
        logger.error("runner.ws", "utility_query_failed", {
          session_id: state.SESSION_ID,
          error: err instanceof Error ? err.message : String(err),
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "utility_query_result",
            session_id: state.SESSION_ID,
            text: "",
            error: err instanceof Error ? err.message : String(err),
            request_id: requestId,
            trace_id: traceId,
          }));
        }
      }
    })();
    return;
  }

  if (msg.type === "adopt") {
    logger.info("runner.ws", "adopt_received", {
      old_session_id: state.SESSION_ID,
      new_session_id: msg.session_id,
      has_repo: !!msg.config?.repo,
      model: msg.config?.model,
    });

    state.SESSION_ID = msg.session_id;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = msg.oauth_token;

    const cfg = msg.config || {};
    if (cfg.repo !== undefined) state.REPO = cfg.repo;
    if (cfg.branch !== undefined) state.BRANCH = cfg.branch || "main";
    if (cfg.gitToken !== undefined) {
      state.GIT_TOKEN = cfg.gitToken;
      if (cfg.gitToken) process.env.RUNNER_GIT_TOKEN = cfg.gitToken;
    }
    if (cfg.model !== undefined) state.MODEL = cfg.model || "sonnet";
    if (cfg.systemPrompt !== undefined) state.SYSTEM_PROMPT = cfg.systemPrompt;
    if (cfg.appendSystemPrompt !== undefined) state.APPEND_SYSTEM_PROMPT = cfg.appendSystemPrompt;
    if (cfg.maxTurns !== undefined) state.MAX_TURNS = cfg.maxTurns;
    if (cfg.thinking !== undefined) state.THINKING = !!cfg.thinking;
    if (cfg.allowedTools !== undefined) state.ALLOWED_TOOLS = cfg.allowedTools || [];
    if (cfg.disallowedTools !== undefined) state.DISALLOWED_TOOLS = cfg.disallowedTools || [];
    if (cfg.compactInstructions !== undefined) state.COMPACT_INSTRUCTIONS = cfg.compactInstructions;
    if (cfg.permissionMode !== undefined) state.PERMISSION_MODE = cfg.permissionMode || "bypassPermissions";
    if (cfg.mcpServers !== undefined) state.MCP_SERVERS = cfg.mcpServers || {};
    if (cfg.allowedPaths !== undefined) state.ALLOWED_PATHS = cfg.allowedPaths || [];

    try {
      if (cfg.vault !== undefined) state.VAULT = cfg.vault;

      if (state.REPO) {
        ws.send(JSON.stringify({ type: "status", session_id: state.SESSION_ID, status: "cloning" }));
        cloneRepo();
      } else if (state.VAULT) {
        ws.send(JSON.stringify({ type: "status", session_id: state.SESSION_ID, status: "syncing" }));
        syncVault();
      }

      if (!existsSync(state.WORKSPACE)) {
        mkdirSync(state.WORKSPACE, { recursive: true });
      }

      process.chdir(state.WORKSPACE);

      if (state.session) {
        logger.info("runner.ws", "adopt_reconfiguring_session", { session_id: state.SESSION_ID });
        if (cfg.model) await (state.session as any).query.setModel(cfg.model);
        if (cfg.mcpServers !== undefined) await (state.session as any).query.setMcpServers(cfg.mcpServers || {});
        if (cfg.permissionMode) await (state.session as any).query.setPermissionMode(cfg.permissionMode);
        if (state.THINKING) {
          await (state.session as any).query.setMaxThinkingTokens(10000);
          logger.info("runner.ws", "adopt_session_reconfigured", { session_id: state.SESSION_ID });
        } else {
          // Close session — setMaxThinkingTokens(0) doesn't reliably disable thinking.
          // Session will be lazily recreated without thinking on next runTurn.
          state.session.close();
          state.session = null;
          logger.info("runner.ws", "adopt_session_closed_for_thinking_off", { session_id: state.SESSION_ID });
        }
      } else {
        state.session = await createOrResumeSession(ws);
        logger.info("runner.ws", "adopt_session_created", { session_id: state.SESSION_ID });
      }

      ws.send(JSON.stringify({ type: "status", session_id: state.SESSION_ID, status: "ready" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("runner.ws", "adopt_failed", { session_id: state.SESSION_ID, error: message });
      try {
        if (state.session) {
          state.session.close();
          state.session = null;
        }
        state.sdkSessionId = undefined;
        state.session = await createOrResumeSession(ws);
        logger.info("runner.ws", "adopt_fallback_session_created", { session_id: state.SESSION_ID });
        ws.send(JSON.stringify({ type: "status", session_id: state.SESSION_ID, status: "ready" }));
      } catch (fallbackErr) {
        const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        logger.error("runner.ws", "adopt_fallback_failed", { session_id: state.SESSION_ID, error: fallbackMessage });
        ws.send(JSON.stringify({ type: "error", session_id: state.SESSION_ID, code: "adopt_failed", message: fallbackMessage }));
      }
    }
    return;
  }

  if (msg.type === "shutdown") {
    logger.info("runner.ws", "shutdown_requested", { session_id: state.SESSION_ID });
    stopVaultSync();
    state.ipc?.disconnect();
    state.session?.close();
    ws.close();
    process.exit(0);
  }
}

export async function preloadWarmSession(ws: WebSocket): Promise<void> {
  if (!state.session && !state.REPO && !state.VAULT) {
    try {
      state.session = await createOrResumeSession(ws);
      logger.info("runner.ws", "warm_session_preloaded");
    } catch (err) {
      logger.warn("runner.ws", "warm_session_preload_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

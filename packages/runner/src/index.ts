import WebSocket from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import type { OrchestratorCommand, ContextOperation } from "@claude-agent-runner/shared";
import {
  readSessionChain,
  removeMessage,
  injectMessage,
  truncateToLastN,
  getContextStats,
} from "./context.js";
import { serializeEvent } from "./serialize.js";
import { createStderrRingBuffer, buildZeroEventError } from "./helpers.js";
import { runWithLogContext, logger } from "./logger.js";

// --- Config from env ---

const SESSION_ID = process.env.RUNNER_SESSION_ID || randomUUID();
const ORCHESTRATOR_URL = process.env.RUNNER_ORCHESTRATOR_URL;
const REPO = process.env.RUNNER_REPO;
const BRANCH = process.env.RUNNER_BRANCH || "main";
const GIT_TOKEN = process.env.RUNNER_GIT_TOKEN;
const MODEL = process.env.RUNNER_MODEL || "sonnet";
const SYSTEM_PROMPT = process.env.RUNNER_SYSTEM_PROMPT;
const APPEND_SYSTEM_PROMPT = process.env.RUNNER_APPEND_SYSTEM_PROMPT;
const MAX_TURNS = process.env.RUNNER_MAX_TURNS ? parseInt(process.env.RUNNER_MAX_TURNS, 10) : undefined;
const THINKING = process.env.RUNNER_THINKING === "true";
const ALLOWED_TOOLS: string[] = process.env.RUNNER_ALLOWED_TOOLS
  ? JSON.parse(process.env.RUNNER_ALLOWED_TOOLS)
  : [];
const DISALLOWED_TOOLS: string[] = process.env.RUNNER_DISALLOWED_TOOLS
  ? JSON.parse(process.env.RUNNER_DISALLOWED_TOOLS)
  : [];
const ADDITIONAL_DIRECTORIES: string[] = process.env.RUNNER_ADDITIONAL_DIRECTORIES
  ? JSON.parse(process.env.RUNNER_ADDITIONAL_DIRECTORIES)
  : [];
const COMPACT_INSTRUCTIONS = process.env.RUNNER_COMPACT_INSTRUCTIONS;
const FORK_FROM = process.env.RUNNER_FORK_FROM;
const FORK_AT = process.env.RUNNER_FORK_AT;
const FORK_SESSION = process.env.RUNNER_FORK_SESSION === "true";
const FIRST_EVENT_TIMEOUT_MS = parseInt(process.env.RUNNER_FIRST_EVENT_TIMEOUT_MS || "90000", 10);
const COMPACT_THRESHOLD_PCT = parseInt(process.env.RUNNER_COMPACT_THRESHOLD_PCT || "20", 10);
const WORKSPACE = "/workspace";

if (!ORCHESTRATOR_URL) {
  logger.error("runner.config", "RUNNER_ORCHESTRATOR_URL is required");
  process.exit(1);
}

logger.info("runner.config", "runner_startup_config", {
  session_id: SESSION_ID,
  orchestrator_url: ORCHESTRATOR_URL,
  model: MODEL,
  workspace: WORKSPACE,
  repo: REPO ? "provided" : "none",
  fork_session: FORK_SESSION,
  branch: BRANCH,
});

// --- Git clone ---

function cloneRepo(): void {
  if (!REPO) {
    logger.info("runner.git", "repo_not_configured", { session_id: SESSION_ID });
    return;
  }
  if (existsSync(`${WORKSPACE}/.git`)) {
    logger.info("runner.git", "workspace_already_initialized", { workspace: WORKSPACE });
    return;
  }

  let cloneUrl = REPO;
  if (GIT_TOKEN && cloneUrl.startsWith("https://")) {
    // Inject token for private repos: https://x-access-token:TOKEN@github.com/...
    cloneUrl = cloneUrl.replace("https://", `https://x-access-token:${GIT_TOKEN}@`);
  }

  logger.info("runner.git", "clone_start", { repo: REPO, branch: BRANCH, workspace: WORKSPACE });
  try {
    execSync(`git clone --branch ${BRANCH} --single-branch --depth 1 ${cloneUrl} ${WORKSPACE}`, {
      stdio: "inherit",
      timeout: 120_000,
    });
    logger.info("runner.git", "clone_complete", { workspace: WORKSPACE });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("runner.git", "clone_failed", { session_id: SESSION_ID, repo: REPO, branch: BRANCH, error: message });
    throw new Error(`Git clone failed: ${message}`);
  }
}

function buildClaudeChildEnv(forceCompact = false): Record<string, string> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) {
    logger.error("runner.config", "missing_oauth_token", { session_id: SESSION_ID });
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for Claude child process");
  }

  return {
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/runner",
    USER: "runner",
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    TERM: "dumb",
    // Auto-compact threshold: 1% forces immediate compact, otherwise use configured %
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: forceCompact ? "1" : String(COMPACT_THRESHOLD_PCT),
  };
}

function getJsonlPath(): string {
  if (!sessionId) throw new Error("SDK session ID not yet established");
  return `/home/runner/.claude/projects/-workspace/${sessionId}.jsonl`;
}

// --- Agent runner ---

let sessionId: string | undefined;
let setupCompleted = false;
let isBusy = false;
let forceCompactOnNextQuery = false;
let pendingCompactInstructions: string | undefined = undefined;

// Active query handle — allows external abort for steer
let activeResponse: ReturnType<typeof query> | null = null;

// Pending steer: set by `steer` command, consumed by message handler after abort
let pendingSteer: {
  message: string;
  model?: string;
  maxTurns?: number;
  requestId?: string;
  traceId?: string;
  compact?: boolean;
  compactInstructions?: string;
  operations?: ContextOperation[];
} | null = null;

async function runAgent(
  ws: WebSocket,
  message: string,
  overrides?: {
    model?: string;
    maxTurns?: number;
    requestId?: string;
    traceId?: string;
    forceCompact?: boolean;
    compactInstructionsOverride?: string;
  },
): Promise<void> {
  const model = overrides?.model || MODEL;
  const maxTurns = overrides?.maxTurns ?? MAX_TURNS;
  const requestId = overrides?.requestId;
  const traceId = overrides?.traceId;
  const forceCompact = overrides?.forceCompact ?? false;
  const childEnv = buildClaudeChildEnv(forceCompact);
  const stderrRing = createStderrRingBuffer(200);

  const effectiveCompactInstructions = overrides?.compactInstructionsOverride ?? COMPACT_INSTRUCTIONS;
  const hooks: Record<string, any[]> = {};
  if (effectiveCompactInstructions) {
    hooks.PreCompact = [{
      hooks: [async () => ({
        continue: true,
        systemMessage: effectiveCompactInstructions,
      })],
    }];
  }

  logger.info("runner.agent", "query_start", {
    session_id: SESSION_ID,
    request_id: requestId,
    trace_id: traceId,
    model,
    max_turns: maxTurns,
    has_append_prompt: Boolean(APPEND_SYSTEM_PROMPT),
    has_system_prompt: Boolean(SYSTEM_PROMPT),
    has_fork_from: Boolean(FORK_FROM),
  });

  const response = query({
    prompt: message,
    options: {

      model,
      ...(SYSTEM_PROMPT ? { systemPrompt: SYSTEM_PROMPT } : {}),
      ...(APPEND_SYSTEM_PROMPT ? { appendSystemPrompt: APPEND_SYSTEM_PROMPT } : {}),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(THINKING ? { maxThinkingTokens: 10000 } : {}),
      ...(ALLOWED_TOOLS.length > 0 ? { tools: ALLOWED_TOOLS } : {}),
      ...(DISALLOWED_TOOLS.length > 0 ? { disallowedTools: DISALLOWED_TOOLS } : {}),
      cwd: WORKSPACE,
      includePartialMessages: true,
      persistSession: true,
      enableFileCheckpointing: true,
      ...((sessionId || FORK_FROM) ? { resume: sessionId || FORK_FROM } : {}),
      ...(FORK_SESSION && !sessionId ? { forkSession: true } : {}),
      ...(FORK_AT && !sessionId ? { resumeSessionAt: FORK_AT } : {}),
      settingSources: ["project"],
      ...(ADDITIONAL_DIRECTORIES.length > 0 ? { additionalDirectories: ADDITIONAL_DIRECTORIES } : {}),
      ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
      env: childEnv,
      stderr: (data: string) => {
        stderrRing.push(data);
        logger.debug("runner.agent", "sdk_stderr", { session_id: SESSION_ID, data: data.trim().slice(0, 500) });
      },
    },
  });
  activeResponse = response;

  logger.debug("runner.agent", "query_invoked", {
    session_id: SESSION_ID,
    cwd: WORKSPACE,
    model,
    max_turns: maxTurns,
  });

  let eventCount = 0;
  let firstEventTimeoutTriggered = false;
  const firstEventTimer = setTimeout(() => {
    firstEventTimeoutTriggered = true;
    logger.error("runner.agent", "first_event_timeout", {
      session_id: SESSION_ID,
      timeout_ms: FIRST_EVENT_TIMEOUT_MS,
    });
    response.close();
  }, FIRST_EVENT_TIMEOUT_MS);

  try {
    try {
      for await (const event of response) {
        if (eventCount === 0) {
          clearTimeout(firstEventTimer);
        }

        eventCount++;

        // Capture session ID from first message and report back to orchestrator
        if (!sessionId && "session_id" in event && event.session_id) {
          sessionId = event.session_id;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "session_init",
              session_id: SESSION_ID,
              sdk_session_id: sessionId,
              request_id: requestId,
              trace_id: traceId,
            }));
          }
          logger.info("runner.agent", "session_id_acquired", {
            runner_session_id: SESSION_ID,
            sdk_session_id: sessionId,
            request_id: requestId,
            trace_id: traceId,
          });
        }

        // Forward event to orchestrator
        const serialized = serializeEvent(event);
        if (serialized && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "event",
            session_id: SESSION_ID,
            event: serialized,
            request_id: requestId,
            trace_id: traceId,
          }));
        }

        logger.debug("runner.agent", "sdk_event", {
          session_id: SESSION_ID,
          sdk_session_id: sessionId,
          event_type: event.type,
          event_subtype: event.subtype,
        });

        // Track context window size from result events
        if (event.type === "result" && event.modelUsage && ws.readyState === WebSocket.OPEN) {
          const modelEntries = Object.values(event.modelUsage as Record<string, any>);
          const contextWindow = modelEntries[0]?.contextWindow ?? 0;
          if (contextWindow > 0) {
            ws.send(JSON.stringify({
              type: "context_state",
              session_id: SESSION_ID,
              context_tokens: contextWindow,
              compacted: forceCompact,
              request_id: requestId,
              trace_id: traceId,
            }));
          }
        }

        // Detect auto-compact boundary events
        if (event.type === "system" && event.subtype === "compact_boundary" && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "context_state",
            session_id: SESSION_ID,
            context_tokens: event.compact_metadata?.pre_tokens ?? 0,
            compacted: true,
            request_id: requestId,
            trace_id: traceId,
          }));
        }

        // Stop on result
        if (event.type === "result") {
          logger.info("runner.agent", "result_received", {
            session_id: SESSION_ID,
            sdk_session_id: sessionId,
            result_type: event.subtype,
          });
          break;
        }
      }
    } catch (iterErr) {
      if (firstEventTimeoutTriggered && eventCount === 0) {
        throw new Error(buildZeroEventError(
          "Timed out waiting for first SDK event",
          model,
          maxTurns,
          WORKSPACE,
          Object.keys(childEnv).sort(),
          stderrRing.tail(80),
        ));
      }

      logger.error("runner.agent", "sdk_iteration_error", {
        session_id: SESSION_ID,
        error: iterErr instanceof Error ? iterErr.message : String(iterErr),
      });
      throw iterErr;
    }

    if (eventCount === 0) {
      const reason = firstEventTimeoutTriggered
        ? "Timed out waiting for first SDK event"
        : "SDK query completed with zero events";
      throw new Error(buildZeroEventError(
        reason,
        model,
        maxTurns,
        WORKSPACE,
        Object.keys(childEnv).sort(),
        stderrRing.tail(80),
      ));
    }

    logger.info("runner.agent", "total_events", {
      session_id: SESSION_ID,
      sdk_session_id: sessionId,
      event_count: eventCount,
    });
  } finally {
    clearTimeout(firstEventTimer);
    activeResponse = null;
    response.close();
    logger.debug("runner.agent", "query_closed", { session_id: SESSION_ID });
  }
}

/** Execute a single JSONL context operation. Throws on error. */
function executeContextOp(op: ContextOperation): any {
  const path = getJsonlPath();
  switch (op.op) {
    case "get_context":
      return readSessionChain(path);
    case "get_stats":
      return getContextStats(path);
    case "remove_message":
      removeMessage(path, op.uuid);
      return undefined;
    case "inject_message":
      return { injected_uuid: injectMessage(path, op.content, op.role, op.after_uuid) };
    case "truncate":
      truncateToLastN(path, op.keep_last_n);
      return undefined;
  }
}

// --- WebSocket connection to orchestrator ---

function connect(): void {
  logger.info("runner.ws", "connecting", { orchestrator_url: ORCHESTRATOR_URL, session_id: SESSION_ID });
  const ws = new WebSocket(ORCHESTRATOR_URL!);

  ws.on("open", () => {
    logger.info("runner.ws", "connected", { session_id: SESSION_ID });

    // Setup phase: clone repo if needed
    try {
      if (!setupCompleted) {
        if (REPO) {
          ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "cloning" }));
          cloneRepo();
        }

        // Ensure workspace dir exists (it's pre-created by the Dockerfile,
        // but create it just in case for ephemeral sessions with no repo/workspace).
        if (!existsSync(WORKSPACE)) {
          mkdirSync(WORKSPACE, { recursive: true });
        }

        setupCompleted = true;
      }

      ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "ready" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("runner.ws", "setup_failed", { session_id: SESSION_ID, error: message });
      ws.send(JSON.stringify({ type: "error", session_id: SESSION_ID, code: "clone_failed", message }));
      ws.close();
      process.exit(1);
    }
  });

  ws.on("message", async (data) => {
    let msg: OrchestratorCommand;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      logger.warn("runner.ws", "invalid_json_from_orchestrator", { session_id: SESSION_ID });
      return;
    }

    if (msg.type === "message") {
      const requestId = msg.request_id;
      const traceId = msg.trace_id;
      return runWithLogContext({ sessionId: SESSION_ID, requestId, traceId }, async () => {
        logger.info("runner.ws", "message_received", {
          session_id: SESSION_ID,
          message_preview: msg.message?.slice(0, 120),
          model: msg.model,
          request_id: requestId,
          trace_id: traceId,
        });
        isBusy = true;
        ws.send(JSON.stringify({
          type: "status",
          session_id: SESSION_ID,
          status: "busy",
          request_id: requestId,
          trace_id: traceId,
        }));

        // Consume pending compact flags
        let useForceCompact = forceCompactOnNextQuery;
        let useCompactInstructions = pendingCompactInstructions;
        forceCompactOnNextQuery = false;
        pendingCompactInstructions = undefined;

        // Current query params — may be replaced by steer
        let currentMessage = msg.message;
        let currentModel = msg.model;
        let currentMaxTurns = msg.maxTurns;
        let currentRequestId = requestId;
        let currentTraceId = traceId;

        // Loop: run query, then check for pending steer (abort → edit → resume)
        while (true) {
          try {
            logger.debug("runner.ws", "run_agent_starting", { session_id: SESSION_ID, request_id: currentRequestId });
            await runAgent(ws, currentMessage, {
              model: currentModel,
              maxTurns: currentMaxTurns,
              requestId: currentRequestId,
              traceId: currentTraceId,
              forceCompact: useForceCompact,
              compactInstructionsOverride: useCompactInstructions,
            });
            logger.debug("runner.ws", "run_agent_completed", { session_id: SESSION_ID, request_id: currentRequestId });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            // Only send error event if this wasn't a steer-initiated abort
            if (!pendingSteer) {
              logger.error("runner.ws", "agent_execution_failed", { session_id: SESSION_ID, error: errorMsg });
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: "event",
                  session_id: SESSION_ID,
                  request_id: currentRequestId,
                  trace_id: currentTraceId,
                  event: {
                    type: "result",
                    subtype: "error_during_execution",
                    result: "",
                    errors: [errorMsg],
                    usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 },
                  },
                }));
              }
            } else {
              logger.info("runner.ws", "query_aborted_for_steer", { session_id: SESSION_ID, request_id: currentRequestId });
            }
          }

          // Check for pending steer: if set, execute operations and loop with new query
          if (!pendingSteer) break;

          const steer = pendingSteer;
          pendingSteer = null;

          logger.info("runner.ws", "steer_executing", {
            session_id: SESSION_ID,
            request_id: steer.requestId,
            operations_count: steer.operations?.length ?? 0,
            has_compact: Boolean(steer.compact),
          });

          // Execute JSONL operations before resuming
          if (steer.operations && steer.operations.length > 0 && sessionId) {
            for (const op of steer.operations) {
              try {
                executeContextOp(op);
                logger.debug("runner.ws", "steer_op_executed", { session_id: SESSION_ID, op: op.op });
              } catch (opErr) {
                const opErrMsg = opErr instanceof Error ? opErr.message : String(opErr);
                logger.error("runner.ws", "steer_op_failed", { session_id: SESSION_ID, op: op.op, error: opErrMsg });
              }
            }
          }

          // Notify orchestrator of steer
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "status",
              session_id: SESSION_ID,
              status: "busy",
              request_id: steer.requestId,
              trace_id: steer.traceId,
            }));
          }

          // Set up next iteration with steer params
          currentMessage = steer.message;
          currentModel = steer.model;
          currentMaxTurns = steer.maxTurns;
          currentRequestId = steer.requestId;
          currentTraceId = steer.traceId;
          useForceCompact = steer.compact ?? false;
          useCompactInstructions = steer.compactInstructions;
        }

        isBusy = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "status",
            session_id: SESSION_ID,
            status: "ready",
            request_id: currentRequestId,
            trace_id: currentTraceId,
          }));
        }
      });
    }

    if (msg.type === "compact") {
      forceCompactOnNextQuery = true;
      pendingCompactInstructions = (msg as any).custom_instructions;
      logger.info("runner.ws", "compact_scheduled", {
        session_id: SESSION_ID,
        has_custom_instructions: Boolean(pendingCompactInstructions),
        request_id: (msg as any).request_id,
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "status",
          session_id: SESSION_ID,
          status: "ready",
          request_id: (msg as any).request_id,
        }));
      }
      return;
    }

    if (msg.type === "steer") {
      const steerMsg = msg as any;
      const steerRequestId = steerMsg.request_id;
      const steerTraceId = steerMsg.trace_id;

      logger.info("runner.ws", "steer_received", {
        session_id: SESSION_ID,
        is_busy: isBusy,
        has_active_response: Boolean(activeResponse),
        message_preview: steerMsg.message?.slice(0, 120),
        operations_count: steerMsg.operations?.length ?? 0,
        request_id: steerRequestId,
      });

      if (isBusy && activeResponse) {
        // Mid-query steer: set pending and abort the running query
        pendingSteer = {
          message: steerMsg.message,
          model: steerMsg.model,
          maxTurns: steerMsg.maxTurns,
          requestId: steerRequestId,
          traceId: steerTraceId,
          compact: steerMsg.compact,
          compactInstructions: steerMsg.compact_instructions,
          operations: steerMsg.operations,
        };
        activeResponse.close(); // triggers abort → message handler catches → consumes pendingSteer
      } else {
        // Not busy: execute operations and send as a normal message
        return runWithLogContext({ sessionId: SESSION_ID, requestId: steerRequestId, traceId: steerTraceId }, async () => {
          isBusy = true;
          ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "busy", request_id: steerRequestId, trace_id: steerTraceId }));

          // Execute JSONL operations
          if (steerMsg.operations && steerMsg.operations.length > 0 && sessionId) {
            for (const op of steerMsg.operations as ContextOperation[]) {
              try {
                executeContextOp(op);
              } catch (opErr) {
                const opErrMsg = opErr instanceof Error ? opErr.message : String(opErr);
                logger.error("runner.ws", "steer_idle_op_failed", { session_id: SESSION_ID, op: op.op, error: opErrMsg });
              }
            }
          }

          try {
            await runAgent(ws, steerMsg.message, {
              model: steerMsg.model,
              maxTurns: steerMsg.maxTurns,
              requestId: steerRequestId,
              traceId: steerTraceId,
              forceCompact: steerMsg.compact ?? false,
              compactInstructionsOverride: steerMsg.compact_instructions,
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error("runner.ws", "steer_idle_agent_failed", { session_id: SESSION_ID, error: errorMsg });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "event", session_id: SESSION_ID, request_id: steerRequestId, trace_id: steerTraceId,
                event: { type: "result", subtype: "error_during_execution", result: "", errors: [errorMsg], usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 } },
              }));
            }
          }

          isBusy = false;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "ready", request_id: steerRequestId, trace_id: steerTraceId }));
          }
        });
      }
      return;
    }

    if (msg.type === "context") {
      const ctxMsg = msg as any;
      const requestId = ctxMsg.request_id;

      if (isBusy) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "context_result",
            session_id: SESSION_ID,
            success: false,
            error: "Session is busy",
            request_id: requestId,
          }));
        }
        return;
      }

      try {
        const op: ContextOperation = ctxMsg.operation;
        const resultData = executeContextOp(op);

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "context_result",
            session_id: SESSION_ID,
            success: true,
            data: resultData,
            request_id: requestId,
            trace_id: ctxMsg.trace_id,
          }));
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("runner.ws", "context_operation_failed", { session_id: SESSION_ID, error: errorMsg });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "context_result",
            session_id: SESSION_ID,
            success: false,
            error: errorMsg,
            request_id: requestId,
          }));
        }
      }
      return;
    }

    if (msg.type === "shutdown") {
      logger.info("runner.ws", "shutdown_requested", { session_id: SESSION_ID });
      ws.close();
      process.exit(0);
    }
  });

  ws.on("close", () => {
    logger.warn("runner.ws", "disconnected", { session_id: SESSION_ID, reconnect_delay_ms: 3000 });
    // Attempt reconnect after 3s
    setTimeout(connect, 3000);
  });

  ws.on("error", (err) => {
    logger.error("runner.ws", "websocket_error", {
      session_id: SESSION_ID,
      error: err.message,
    });
  });
}

// --- Start ---

logger.info("runner.start", "starting_runner", { session_id: SESSION_ID });
connect();

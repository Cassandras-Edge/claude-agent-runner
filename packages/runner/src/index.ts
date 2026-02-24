import WebSocket from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import type { OrchestratorCommand } from "@claude-agent-runner/shared";
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

function buildClaudeChildEnv(): Record<string, string> {
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
  };
}

// --- Agent runner ---

let sessionId: string | undefined;
let setupCompleted = false;

async function runAgent(
  ws: WebSocket,
  message: string,
  overrides?: { model?: string; maxTurns?: number; requestId?: string; traceId?: string },
): Promise<void> {
  const model = overrides?.model || MODEL;
  const maxTurns = overrides?.maxTurns ?? MAX_TURNS;
  const requestId = overrides?.requestId;
  const traceId = overrides?.traceId;
  const childEnv = buildClaudeChildEnv();
  const stderrRing = createStderrRingBuffer(200);

  const hooks: Record<string, any[]> = {};
  if (COMPACT_INSTRUCTIONS) {
    hooks.PreCompact = [{
      hooks: [async () => ({
        continue: true,
        systemMessage: COMPACT_INSTRUCTIONS,
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
    response.close();
    logger.debug("runner.agent", "query_closed", { session_id: SESSION_ID });
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

        if (!existsSync(WORKSPACE)) {
          throw new Error(`Workspace not found at ${WORKSPACE}`);
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
        ws.send(JSON.stringify({
          type: "status",
          session_id: SESSION_ID,
          status: "busy",
          request_id: requestId,
          trace_id: traceId,
        }));

        try {
          logger.debug("runner.ws", "run_agent_starting", { session_id: SESSION_ID });
          await runAgent(ws, msg.message, { model: msg.model, maxTurns: msg.maxTurns, requestId, traceId });
          logger.debug("runner.ws", "run_agent_completed", { session_id: SESSION_ID });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error("runner.ws", "agent_execution_failed", { session_id: SESSION_ID, error: errorMsg });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "event",
              session_id: SESSION_ID,
              request_id: requestId,
              trace_id: traceId,
              event: {
                type: "result",
                subtype: "error_during_execution",
                result: "",
                errors: [errorMsg],
                usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 },
              },
            }));
          }
        }

        ws.send(JSON.stringify({
          type: "status",
          session_id: SESSION_ID,
          status: "ready",
          request_id: requestId,
          trace_id: traceId,
        }));
      });
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

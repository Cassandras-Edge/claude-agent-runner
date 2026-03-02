import WebSocket from "ws";
import {
  query,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKSession, SDKSessionOptions } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import type { OrchestratorCommand, OrchestratorForkAndSteerCommand, ContextOperation } from "@claude-agent-runner/shared";
import {
  readSessionChain,
  removeMessage,
  injectMessage,
  truncateToLastN,
  getContextStats,
} from "./context.js";
import { serializeEvent } from "./serialize.js";
import { createStderrRingBuffer, buildZeroEventError } from "./helpers.js";
import { drainBackground, type DrainResult } from "./background-drainer.js";
import { mergeBackResult } from "./merge-back.js";
import { runWithLogContext, logger } from "./logger.js";
import { MemIpcClient } from "./mem-ipc.js";

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

// IPC socket path for live context surgery (mutable: changes on fork-and-steer)
let MEM_SOCKET_PATH = process.env.CLAUDE_MEM_SOCKET || "/tmp/claude-mem.sock";

// Patched CLI executable (set in Docker, fallback to global claude for dev)
const PATCHED_CLI_PATH = process.env.CLAUDE_PATCHED_CLI || undefined;

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
  ipc_socket: MEM_SOCKET_PATH,
  patched_cli: PATCHED_CLI_PATH ? "provided" : "default",
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

// --- Build child env ---

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
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: forceCompact ? "1" : String(COMPACT_THRESHOLD_PCT),
    CLAUDE_MEM_SOCKET: MEM_SOCKET_PATH,
  };
}

function getJsonlPath(): string {
  if (!sdkSessionId) throw new Error("SDK session ID not yet established");
  return `/home/runner/.claude/projects/-workspace/${sdkSessionId}.jsonl`;
}

// --- Session state ---

let sdkSessionId: string | undefined;
let session: SDKSession | null = null;
let ipc: MemIpcClient | null = null;
let setupCompleted = false;
let isBusy = false;
let forceCompactOnNextQuery = false;
let pendingCompactInstructions: string | undefined = undefined;

// V1 fallback: active query handle for abort (used when V2 session is not available)
let activeResponse: ReturnType<typeof query> | null = null;

// Pending steer: set by `steer` command, consumed by message handler after interrupt
let pendingSteer: {
  message: string;
  model?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
  requestId?: string;
  traceId?: string;
  compact?: boolean;
  compactInstructions?: string;
  operations?: ContextOperation[];
} | null = null;

// Pending fork-and-steer: set by `fork_and_steer` command, consumed after stream loop breaks
let pendingForkAndSteer: {
  message: string;
  model?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
  requestId?: string;
  traceId?: string;
} | null = null;

// Background sessions: tracks sessions that were forked off and are finishing work
type BackgroundSession = {
  sdkSessionId: string;
  taskId: string;
  toolUseSummary: string;
  drainPromise: Promise<DrainResult>;
};
const backgroundSessions: Map<string, BackgroundSession> = new Map();

// --- V2 Session creation ---

function buildSessionOptions(forceCompact = false): SDKSessionOptions & Record<string, any> {
  const childEnv = buildClaudeChildEnv(forceCompact);

  const effectiveCompactInstructions = COMPACT_INSTRUCTIONS;
  const hooks: Record<string, any[]> = {};
  if (effectiveCompactInstructions) {
    hooks.PreCompact = [{
      hooks: [async () => ({
        continue: true,
        systemMessage: effectiveCompactInstructions,
      })],
    }];
  }

  const opts: SDKSessionOptions & Record<string, any> = {
    model: MODEL,
    env: childEnv,
    ...(ALLOWED_TOOLS.length > 0 ? { allowedTools: ALLOWED_TOOLS } : {}),
    ...(DISALLOWED_TOOLS.length > 0 ? { disallowedTools: DISALLOWED_TOOLS } : {}),
    permissionMode: "bypassPermissions" as any,
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(PATCHED_CLI_PATH ? { pathToClaudeCodeExecutable: PATCHED_CLI_PATH, executable: "bun" as const } : {}),
    // Extended options — passed through to CLI args by SDK if supported
    ...(SYSTEM_PROMPT ? { systemPrompt: SYSTEM_PROMPT } : {}),
    ...(APPEND_SYSTEM_PROMPT ? { appendSystemPrompt: APPEND_SYSTEM_PROMPT } : {}),
    ...(MAX_TURNS !== undefined ? { maxTurns: MAX_TURNS } : {}),
    ...(THINKING ? { maxThinkingTokens: 10000 } : {}),
    cwd: WORKSPACE,
    includePartialMessages: true,
    persistSession: true,
    enableFileCheckpointing: true,
    allowDangerouslySkipPermissions: true,
    settingSources: ["project"],
    ...(ADDITIONAL_DIRECTORIES.length > 0 ? { additionalDirectories: ADDITIONAL_DIRECTORIES } : {}),
  };

  return opts;
}

async function createOrResumeSession(): Promise<SDKSession> {
  const opts = buildSessionOptions();

  if (FORK_FROM && !sdkSessionId) {
    // Fork from parent session
    logger.info("runner.session", "resuming_session_for_fork", {
      fork_from: FORK_FROM,
      fork_at: FORK_AT,
    });
    return unstable_v2_resumeSession(FORK_FROM, {
      ...opts,
      ...(FORK_SESSION ? { forkSession: true } : {}),
      ...(FORK_AT ? { resumeSessionAt: FORK_AT } : {}),
    } as any);
  }

  if (sdkSessionId) {
    // Resume existing session
    logger.info("runner.session", "resuming_session", { sdk_session_id: sdkSessionId });
    return unstable_v2_resumeSession(sdkSessionId, opts as any);
  }

  // Create new session
  logger.info("runner.session", "creating_new_session");
  return unstable_v2_createSession(opts as any);
}

async function ensureIpcConnected(): Promise<void> {
  if (ipc?.isConnected) return;

  ipc = new MemIpcClient();
  try {
    await ipc.connect(MEM_SOCKET_PATH, 30, 200);
    logger.info("runner.ipc", "ipc_connected", { socket: MEM_SOCKET_PATH });
  } catch (err) {
    logger.warn("runner.ipc", "ipc_connect_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    ipc = null;
  }
}

// --- Run turn (V2 session based) ---

async function runTurn(
  ws: WebSocket,
  message: string,
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
    session_id: SESSION_ID,
    request_id: requestId,
    trace_id: traceId,
    model: overrides?.model || MODEL,
    has_session: Boolean(session),
  });

  // Create or resume V2 session if not yet established
  if (!session) {
    try {
      session = await createOrResumeSession();
      logger.info("runner.session", "session_created");
    } catch (err) {
      logger.error("runner.session", "session_create_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Send message to the session
  await session.send(message);

  let eventCount = 0;
  let firstEventTimeoutTriggered = false;
  const firstEventTimer = setTimeout(() => {
    firstEventTimeoutTriggered = true;
    logger.error("runner.agent", "first_event_timeout", {
      session_id: SESSION_ID,
      timeout_ms: FIRST_EVENT_TIMEOUT_MS,
    });
    // Close session on timeout — forces stream to end
    session?.close();
    session = null;
  }, FIRST_EVENT_TIMEOUT_MS);

  try {
    for await (const event of session.stream()) {
      if (eventCount === 0) {
        clearTimeout(firstEventTimer);
      }

      eventCount++;

      // Capture session ID from first message
      if (!sdkSessionId && "session_id" in event && (event as any).session_id) {
        sdkSessionId = (event as any).session_id;

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "session_init",
            session_id: SESSION_ID,
            sdk_session_id: sdkSessionId,
            request_id: requestId,
            trace_id: traceId,
          }));
        }
        logger.info("runner.agent", "session_id_acquired", {
          runner_session_id: SESSION_ID,
          sdk_session_id: sdkSessionId,
          request_id: requestId,
        });

        // Connect IPC after session init (socket created by patched CLI)
        ensureIpcConnected().catch(() => {});
      }

      // Forward event to orchestrator
      const serialized = serializeEvent(event as any);
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
        event_type: (event as any).type,
        event_subtype: (event as any).subtype,
      });

      // Track context window size from result events
      if ((event as any).type === "result" && (event as any).modelUsage && ws.readyState === WebSocket.OPEN) {
        const modelEntries = Object.values((event as any).modelUsage as Record<string, any>);
        const contextWindow = modelEntries[0]?.contextWindow ?? 0;
        if (contextWindow > 0) {
          ws.send(JSON.stringify({
            type: "context_state",
            session_id: SESSION_ID,
            context_tokens: contextWindow,
            compacted: overrides?.forceCompact ?? false,
            request_id: requestId,
            trace_id: traceId,
          }));
        }
      }

      // Detect auto-compact boundary events
      if ((event as any).type === "system" && (event as any).subtype === "compact_boundary" && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "context_state",
          session_id: SESSION_ID,
          context_tokens: (event as any).compact_metadata?.pre_tokens ?? 0,
          compacted: true,
          request_id: requestId,
          trace_id: traceId,
        }));
      }

      // Stop on result — turn is complete
      if ((event as any).type === "result") {
        logger.info("runner.agent", "result_received", {
          session_id: SESSION_ID,
          sdk_session_id: sdkSessionId,
          result_type: (event as any).subtype,
        });
        break;
      }

      // Stop if pendingSteer was set (mid-turn interrupt)
      if (pendingSteer) {
        logger.info("runner.agent", "stream_interrupted_for_steer", {
          session_id: SESSION_ID,
        });
        break;
      }

      // Stop if pendingForkAndSteer was set (fork background, continue foreground)
      if (pendingForkAndSteer) {
        logger.info("runner.agent", "stream_interrupted_for_fork_and_steer", {
          session_id: SESSION_ID,
        });
        break;
      }
    }
  } catch (iterErr) {
    if (firstEventTimeoutTriggered && eventCount === 0) {
      throw new Error(buildZeroEventError(
        "Timed out waiting for first SDK event",
        overrides?.model || MODEL,
        overrides?.maxTurns ?? MAX_TURNS,
        WORKSPACE,
        [],
        [],
      ));
    }
    logger.error("runner.agent", "sdk_iteration_error", {
      session_id: SESSION_ID,
      error: iterErr instanceof Error ? (iterErr as Error).message : String(iterErr),
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
      overrides?.model || MODEL,
      overrides?.maxTurns ?? MAX_TURNS,
      WORKSPACE,
      [],
      [],
    ));
  }

  logger.info("runner.agent", "turn_complete", {
    session_id: SESSION_ID,
    sdk_session_id: sdkSessionId,
    event_count: eventCount,
  });
}

// --- V1 fallback agent runner (used when V2 is not available) ---

/** @internal V1 fallback agent runner — used when V2 session is unavailable */
export async function runAgentV1(
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

  logger.info("runner.agent", "query_start_v1", {
    session_id: SESSION_ID,
    request_id: requestId,
    model,
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
      ...((sdkSessionId || FORK_FROM) ? { resume: sdkSessionId || FORK_FROM } : {}),
      ...(FORK_SESSION && !sdkSessionId ? { forkSession: true } : {}),
      ...(FORK_AT && !sdkSessionId ? { resumeSessionAt: FORK_AT } : {}),
      settingSources: ["project"],
      ...(ADDITIONAL_DIRECTORIES.length > 0 ? { additionalDirectories: ADDITIONAL_DIRECTORIES } : {}),
      ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
      ...(PATCHED_CLI_PATH ? { pathToClaudeCodeExecutable: PATCHED_CLI_PATH } : {}),
      env: childEnv,
      stderr: (data: string) => {
        stderrRing.push(data);
        logger.debug("runner.agent", "sdk_stderr", { session_id: SESSION_ID, data: data.trim().slice(0, 500) });
      },
    },
  });
  activeResponse = response;

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

        if (!sdkSessionId && "session_id" in event && event.session_id) {
          sdkSessionId = event.session_id;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "session_init",
              session_id: SESSION_ID,
              sdk_session_id: sdkSessionId,
              request_id: requestId,
              trace_id: traceId,
            }));
          }
          logger.info("runner.agent", "session_id_acquired", {
            runner_session_id: SESSION_ID,
            sdk_session_id: sdkSessionId,
          });

          // Connect IPC after session init
          ensureIpcConnected().catch(() => {});
        }

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

        if (event.type === "result") {
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
  } finally {
    clearTimeout(firstEventTimer);
    activeResponse = null;
    response.close();
  }
}

// --- IPC-based context operations ---

async function executeContextOpViaIpc(op: ContextOperation): Promise<any> {
  if (!ipc?.isConnected) {
    throw new Error("IPC not connected — cannot execute context operation");
  }

  switch (op.op) {
    case "get_context":
      return await ipc.getMessages();
    case "get_stats": {
      const length = await ipc.getLength();
      const roles = await ipc.getRoles();
      const breakdown: Record<string, number> = {};
      for (const r of roles) {
        breakdown[r] = (breakdown[r] || 0) + 1;
      }
      return {
        message_count: length,
        turn_count: Math.floor(length / 2),
        type_breakdown: breakdown,
        estimated_tokens: length * 500, // rough estimate
      };
    }
    case "remove_message": {
      const messages = await ipc.getMessages();
      const idx = messages.findIndex((m: any) => m.uuid === op.uuid);
      if (idx === -1) throw new Error(`Message not found: ${op.uuid}`);
      await ipc.splice(idx, 1);
      return undefined;
    }
    case "inject_message": {
      const messages = await ipc.getMessages();
      // Wrap in the same format the CLI uses for mutableMessages:
      // { type, message: { role, content }, uuid, timestamp }
      const innerContent = [{ type: "text", text: op.content }];
      const newMsg: any = {
        type: op.role,
        message: {
          role: op.role,
          content: innerContent,
        },
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      };
      if (op.after_uuid === "__start__") {
        // Insert at the very beginning
        await ipc.splice(0, 0, [newMsg]);
      } else if (op.after_uuid) {
        const afterIdx = messages.findIndex((m: any) => m.uuid === op.after_uuid);
        if (afterIdx === -1) throw new Error(`Message not found: ${op.after_uuid}`);
        await ipc.splice(afterIdx + 1, 0, [newMsg]);
      } else {
        await ipc.push([newMsg]);
      }
      return { injected: true };
    }
    case "truncate": {
      const len = await ipc.getLength();
      const keepN = op.keep_last_n;
      if (len > keepN) {
        await ipc.splice(0, len - keepN);
      }
      return undefined;
    }
  }
}

/** Execute a JSONL context operation (fallback when IPC is not available). */
function executeContextOpJsonl(op: ContextOperation): any {
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

/** Execute a context operation, preferring IPC over JSONL. */
async function executeContextOp(op: ContextOperation): Promise<any> {
  if (ipc?.isConnected) {
    return executeContextOpViaIpc(op);
  }
  return executeContextOpJsonl(op);
}

// --- Snapshot emission ---

async function emitSnapshot(
  ws: WebSocket,
  trigger: "steer" | "compact" | "turn_complete" | "manual",
  requestId?: string,
): Promise<void> {
  if (!ipc?.isConnected) return;

  try {
    const messages = await ipc.getMessages();
    const length = await ipc.getLength();
    const roles = await ipc.getRoles();

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "context_snapshot",
        session_id: SESSION_ID,
        trigger,
        message_count: length,
        roles,
        messages,
        request_id: requestId,
      }));
    }
    logger.debug("runner.snapshot", "snapshot_emitted", {
      session_id: SESSION_ID,
      trigger,
      message_count: length,
    });
  } catch (err) {
    logger.warn("runner.snapshot", "snapshot_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- WebSocket connection to orchestrator ---

function connect(): void {
  logger.info("runner.ws", "connecting", { orchestrator_url: ORCHESTRATOR_URL, session_id: SESSION_ID });
  const ws = new WebSocket(ORCHESTRATOR_URL!);

  ws.on("open", () => {
    logger.info("runner.ws", "connected", { session_id: SESSION_ID });

    try {
      if (!setupCompleted) {
        if (REPO) {
          ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "cloning" }));
          cloneRepo();
        }

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

        let useForceCompact = forceCompactOnNextQuery;
        let useCompactInstructions = pendingCompactInstructions;
        forceCompactOnNextQuery = false;
        pendingCompactInstructions = undefined;

        let currentMessage = msg.message;
        let currentModel = msg.model;
        let currentMaxTurns = msg.maxTurns;
        let currentMaxThinkingTokens = msg.maxThinkingTokens;
        let currentRequestId = requestId;
        let currentTraceId = traceId;

        // Loop: run turn, then check for pending steer
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
              logger.info("runner.ws", "turn_interrupted_for_steer", { session_id: SESSION_ID });
            }
          }

          // Check for pending fork-and-steer (takes priority — preserves background work)
          if (pendingForkAndSteer) {
            const forkReq = pendingForkAndSteer;
            pendingForkAndSteer = null;

            logger.info("runner.ws", "fork_and_steer_executing", {
              session_id: SESSION_ID,
              request_id: forkReq.requestId,
            });

            // 1. The original session is still running — drain it in the background
            const taskId = `fas_${randomUUID().replace(/-/g, "").substring(0, 8)}`;
            if (session) {
              const bgDrain = drainBackground(session, ws, SESSION_ID, taskId);
              backgroundSessions.set(taskId, {
                sdkSessionId: sdkSessionId!,
                taskId,
                toolUseSummary: "fork-and-steer background",
                drainPromise: bgDrain,
              });

              // When background completes, merge result into foreground
              bgDrain.then(async (result) => {
                logger.info("runner.background", "bg_complete", {
                  session_id: SESSION_ID,
                  task_id: taskId,
                  success: result.success,
                });

                // Merge back into foreground session via IPC
                if (ipc?.isConnected) {
                  await mergeBackResult(ipc, result, taskId, SESSION_ID);
                }

                // Notify orchestrator
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "background_complete",
                    session_id: SESSION_ID,
                    task_id: taskId,
                    success: result.success,
                    error: result.error,
                  }));
                }

                backgroundSessions.delete(taskId);
              }).catch((err) => {
                logger.error("runner.background", "bg_merge_failed", {
                  session_id: SESSION_ID,
                  task_id: taskId,
                  error: err instanceof Error ? err.message : String(err),
                });
                backgroundSessions.delete(taskId);
              });
            }

            // 2. Fork a new SDK session from the current JSONL
            //    Use a new IPC socket path so the forked CLI doesn't collide
            //    with the background CLI still using the original socket.
            try {
              const oldSdkSessionId = sdkSessionId!;
              const oldSocketPath = MEM_SOCKET_PATH;
              MEM_SOCKET_PATH = `/tmp/claude-mem-${randomUUID().replace(/-/g, "").substring(0, 8)}.sock`;
              logger.info("runner.ws", "fork_new_socket_path", {
                session_id: SESSION_ID,
                old_socket: oldSocketPath,
                new_socket: MEM_SOCKET_PATH,
              });

              session = await unstable_v2_resumeSession(oldSdkSessionId, {
                ...buildSessionOptions(),
                forkSession: true,
              } as any);

              logger.info("runner.ws", "forked_session_created", {
                session_id: SESSION_ID,
                old_sdk_session: oldSdkSessionId,
                task_id: taskId,
              });

              // The new session's sdkSessionId will be captured by runTurn's
              // stream loop (same as normal session init). Don't try to read
              // from stream here — the CLI waits for input first.

              // 3. Disconnect old IPC (background CLI keeps its socket).
              //    New IPC will connect after the forked CLI starts streaming
              //    (ensureIpcConnected is called in runTurn's stream loop).
              if (ipc) {
                ipc.disconnect();
                ipc = null;
              }

              // 4. Notify orchestrator about the fork
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: "event",
                  session_id: SESSION_ID,
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
                session_id: SESSION_ID,
                error: forkErr instanceof Error ? forkErr.message : String(forkErr),
              });
              // Fall back to normal steer behavior
              pendingSteer = {
                message: forkReq.message,
                model: forkReq.model,
                maxTurns: forkReq.maxTurns,
                requestId: forkReq.requestId,
                traceId: forkReq.traceId,
              };
            }

            // Continue the while loop with the forked session and user's message
            if (!pendingSteer) {
              currentMessage = forkReq.message;
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

          // Check for pending steer
          if (!pendingSteer) break;

          const steer = pendingSteer;
          pendingSteer = null;

          logger.info("runner.ws", "steer_executing", {
            session_id: SESSION_ID,
            request_id: steer.requestId,
            operations_count: steer.operations?.length ?? 0,
          });

          // Execute context operations via IPC
          if (steer.operations && steer.operations.length > 0) {
            for (const op of steer.operations) {
              try {
                await executeContextOp(op);
                logger.debug("runner.ws", "steer_op_executed", { session_id: SESSION_ID, op: op.op });
              } catch (opErr) {
                const opErrMsg = opErr instanceof Error ? opErr.message : String(opErr);
                logger.error("runner.ws", "steer_op_failed", { session_id: SESSION_ID, op: op.op, error: opErrMsg });
              }
            }
          }

          // Emit snapshot after steer mutations
          await emitSnapshot(ws, "steer", steer.requestId);

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "status",
              session_id: SESSION_ID,
              status: "busy",
              request_id: steer.requestId,
              trace_id: steer.traceId,
            }));
          }

          currentMessage = steer.message;
          currentModel = steer.model;
          currentMaxTurns = steer.maxTurns;
          currentMaxThinkingTokens = steer.maxThinkingTokens;
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
        message_preview: steerMsg.message?.slice(0, 120),
        operations_count: steerMsg.operations?.length ?? 0,
        request_id: steerRequestId,
      });

      if (isBusy) {
        // Mid-turn steer: set pending — the stream loop will pick it up
        pendingSteer = {
          message: steerMsg.message,
          model: steerMsg.model,
          maxTurns: steerMsg.maxTurns,
          maxThinkingTokens: steerMsg.maxThinkingTokens,
          requestId: steerRequestId,
          traceId: steerTraceId,
          compact: steerMsg.compact,
          compactInstructions: steerMsg.compact_instructions,
          operations: steerMsg.operations,
        };
        // V1 fallback: close active response to interrupt
        if (activeResponse) {
          activeResponse.close();
        }
        // V2: the stream loop checks pendingSteer and breaks
      } else {
        // Not busy: execute operations via IPC and send as a normal turn
        return runWithLogContext({ sessionId: SESSION_ID, requestId: steerRequestId, traceId: steerTraceId }, async () => {
          isBusy = true;
          ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "busy", request_id: steerRequestId, trace_id: steerTraceId }));

          // Execute context operations via IPC
          if (steerMsg.operations && steerMsg.operations.length > 0) {
            for (const op of steerMsg.operations as ContextOperation[]) {
              try {
                await executeContextOp(op);
              } catch (opErr) {
                const opErrMsg = opErr instanceof Error ? opErr.message : String(opErr);
                logger.error("runner.ws", "steer_idle_op_failed", { session_id: SESSION_ID, op: op.op, error: opErrMsg });
              }
            }
          }

          // Emit snapshot after steer mutations
          await emitSnapshot(ws, "steer", steerRequestId);

          try {
            await runTurn(ws, steerMsg.message, {
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

    if (msg.type === "fork_and_steer") {
      const fasMsg = msg as OrchestratorForkAndSteerCommand;
      const fasRequestId = fasMsg.request_id;
      const fasTraceId = fasMsg.trace_id;

      logger.info("runner.ws", "fork_and_steer_received", {
        session_id: SESSION_ID,
        is_busy: isBusy,
        message_preview: fasMsg.message?.slice(0, 120),
        request_id: fasRequestId,
      });

      if (isBusy) {
        // Mid-turn: set pending — the stream loop will pick it up and fork
        pendingForkAndSteer = {
          message: fasMsg.message,
          model: fasMsg.model,
          maxTurns: fasMsg.maxTurns,
          maxThinkingTokens: (fasMsg as any).maxThinkingTokens,
          requestId: fasRequestId,
          traceId: fasTraceId,
        };
        // V2: the stream loop checks pendingForkAndSteer and breaks
      } else {
        // Not busy: just send as a normal message (no need to fork, nothing is running)
        logger.info("runner.ws", "fork_and_steer_idle_fallback", { session_id: SESSION_ID });
        // Rewrite as a normal message command
        return runWithLogContext({ sessionId: SESSION_ID, requestId: fasRequestId, traceId: fasTraceId }, async () => {
          isBusy = true;
          ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "busy", request_id: fasRequestId, trace_id: fasTraceId }));
          try {
            await runTurn(ws, fasMsg.message, {
              model: fasMsg.model,
              maxTurns: fasMsg.maxTurns,
              maxThinkingTokens: (fasMsg as any).maxThinkingTokens,
              requestId: fasRequestId,
              traceId: fasTraceId,
            });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error("runner.ws", "fork_and_steer_idle_failed", { session_id: SESSION_ID, error: errorMsg });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "event", session_id: SESSION_ID, request_id: fasRequestId, trace_id: fasTraceId,
                event: { type: "result", subtype: "error_during_execution", result: "", errors: [errorMsg], usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 } },
              }));
            }
          }
          isBusy = false;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "ready", request_id: fasRequestId, trace_id: fasTraceId }));
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
        const resultData = await executeContextOp(op);

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
      // Clean up IPC and session
      ipc?.disconnect();
      session?.close();
      ws.close();
      process.exit(0);
    }
  });

  ws.on("close", () => {
    logger.warn("runner.ws", "disconnected", { session_id: SESSION_ID, reconnect_delay_ms: 3000 });
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

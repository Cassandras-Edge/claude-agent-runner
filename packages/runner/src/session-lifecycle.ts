import WebSocket from "ws";
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKSession, SDKSessionOptions } from "@anthropic-ai/claude-agent-sdk";
import { ADDITIONAL_DIRECTORIES, FORK_AT, FORK_FROM, FORK_SESSION, PATCHED_CLI_PATH } from "./config.js";
import { buildClaudeChildEnv } from "./helpers.js";
import { logger } from "./logger.js";
import { MemIpcClient } from "./mem-ipc.js";
import { state } from "./state.js";

export function buildSessionOptions(forceCompact = false, ws?: WebSocket): SDKSessionOptions & Record<string, any> {
  const childEnv = buildClaudeChildEnv(forceCompact);

  const hooks: Record<string, any[]> = {};
  hooks.PreCompact = [{
    hooks: [async () => {
      if (!state.activeCompactInstructions) return { continue: true };
      return {
        continue: true,
        systemMessage: state.activeCompactInstructions,
      };
    }],
  }];

  if (state.ALLOWED_PATHS.length > 0) {
    const pathToolNames = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
    hooks.PreToolUse = hooks.PreToolUse || [];
    hooks.PreToolUse.push({
      hooks: [async (toolName: string, input: any) => {
        if (!pathToolNames.has(toolName)) return { continue: true };
        const filePath = input?.file_path || input?.path || input?.command;
        if (!filePath || typeof filePath !== "string") return { continue: true };
        const isAllowed = state.ALLOWED_PATHS.some((p: string) => filePath.startsWith(p));
        if (!isAllowed) {
          return {
            continue: false,
            message: `Path "${filePath}" is outside allowed directories: ${state.ALLOWED_PATHS.join(", ")}`,
          };
        }
        return { continue: true };
      }],
    });
  }

  const isBypass = state.PERMISSION_MODE === "bypassPermissions";

  const opts: SDKSessionOptions & Record<string, any> = {
    model: state.MODEL,
    env: childEnv,
    ...(state.ALLOWED_TOOLS.length > 0 ? { allowedTools: state.ALLOWED_TOOLS } : {}),
    ...(state.DISALLOWED_TOOLS.length > 0 ? { disallowedTools: state.DISALLOWED_TOOLS } : {}),
    permissionMode: state.PERMISSION_MODE as any,
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(PATCHED_CLI_PATH ? { pathToClaudeCodeExecutable: PATCHED_CLI_PATH, executable: "bun" as const } : {}),
    ...(state.SYSTEM_PROMPT ? { systemPrompt: state.SYSTEM_PROMPT } : {}),
    ...(state.APPEND_SYSTEM_PROMPT ? { appendSystemPrompt: state.APPEND_SYSTEM_PROMPT } : {}),
    ...(state.MAX_TURNS !== undefined ? { maxTurns: state.MAX_TURNS } : {}),
    maxThinkingTokens: state.THINKING ? 10000 : 0,
    cwd: state.WORKSPACE,
    includePartialMessages: true,
    persistSession: true,
    enableFileCheckpointing: true,
    allowDangerouslySkipPermissions: isBypass,
    settingSources: ["project"],
    ...(ADDITIONAL_DIRECTORIES.length > 0 ? { additionalDirectories: ADDITIONAL_DIRECTORIES } : {}),
    ...(Object.keys(state.MCP_SERVERS).length > 0 ? { mcpServers: state.MCP_SERVERS } : {}),
  };

  if (!isBypass && ws) {
    opts.canUseTool = async (toolName: string, input: any, options: { signal: AbortSignal }) => {
      const toolUseId = crypto.randomUUID();
      ws.send(JSON.stringify({
        type: "permission_request",
        session_id: state.SESSION_ID,
        tool_name: toolName,
        tool_use_id: toolUseId,
        input,
      }));

      return new Promise<any>((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          state.pendingPermissionRequests.delete(toolUseId);
          reject(new Error("Permission request aborted"));
        });
        state.pendingPermissionRequests.set(toolUseId, resolve);
      });
    };
  }

  return opts;
}

export async function createOrResumeSession(ws?: WebSocket): Promise<SDKSession> {
  const opts = buildSessionOptions(false, ws);
  let session: SDKSession;

  if (FORK_FROM && !state.sdkSessionId) {
    logger.info("runner.session", "resuming_session_for_fork", {
      fork_from: FORK_FROM,
      fork_at: FORK_AT,
    });
    session = await unstable_v2_resumeSession(FORK_FROM, {
      ...opts,
      ...(FORK_SESSION ? { forkSession: true } : {}),
      ...(FORK_AT ? { resumeSessionAt: FORK_AT } : {}),
    } as any);
  } else if (state.sdkSessionId) {
    logger.info("runner.session", "resuming_session", { sdk_session_id: state.sdkSessionId });
    session = await unstable_v2_resumeSession(state.sdkSessionId, opts as any);
  } else {
    logger.info("runner.session", "creating_new_session", { cwd: opts.cwd, model: opts.model });
    session = await unstable_v2_createSession(opts as any);
  }

  // The V2 session wrapper (SQ) doesn't pass mcpServers, settingSources, systemPrompt,
  // maxTurns, or thinking config through to the internal process manager.
  // Apply them post-creation via session.query methods.
  const query = (session as any).query;
  if (query) {
    if (Object.keys(state.MCP_SERVERS).length > 0) {
      try {
        await query.setMcpServers(state.MCP_SERVERS);
        logger.info("runner.session", "mcp_servers_configured", {
          servers: Object.keys(state.MCP_SERVERS),
        });
      } catch (err) {
        logger.warn("runner.session", "mcp_servers_configure_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return session;
}

export async function ensureIpcConnected(): Promise<void> {
  if (state.ipc?.isConnected) return;

  state.ipc = new MemIpcClient();
  try {
    await state.ipc.connect(state.MEM_SOCKET_PATH, 30, 200);
    logger.info("runner.ipc", "ipc_connected", { socket: state.MEM_SOCKET_PATH });
  } catch (err) {
    logger.warn("runner.ipc", "ipc_connect_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    state.ipc = null;
  }
}

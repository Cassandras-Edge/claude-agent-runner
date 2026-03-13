import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import { state } from "./state.js";

export const ORCHESTRATOR_URL = process.env.RUNNER_ORCHESTRATOR_URL;
export const FORK_FROM = process.env.RUNNER_FORK_FROM;
export const FORK_AT = process.env.RUNNER_FORK_AT;
export const FORK_SESSION = process.env.RUNNER_FORK_SESSION === "true";
export const FIRST_EVENT_TIMEOUT_MS = parseInt(process.env.RUNNER_FIRST_EVENT_TIMEOUT_MS || "90000", 10);
export const COMPACT_THRESHOLD_PCT = parseInt(process.env.RUNNER_COMPACT_THRESHOLD_PCT || "95", 10);
export const COMPACT_MODEL = process.env.RUNNER_COMPACT_MODEL || "claude-sonnet-4-6";
export const ADDITIONAL_DIRECTORIES: string[] = process.env.RUNNER_ADDITIONAL_DIRECTORIES
  ? JSON.parse(process.env.RUNNER_ADDITIONAL_DIRECTORIES)
  : [];
export const PATCHED_CLI_PATH = process.env.CLAUDE_PATCHED_CLI || undefined;

export function initConfig(): void {
  state.SESSION_ID = process.env.RUNNER_SESSION_ID || randomUUID();
  state.REPO = process.env.RUNNER_REPO;
  state.BRANCH = process.env.RUNNER_BRANCH || "main";
  state.GIT_TOKEN = process.env.RUNNER_GIT_TOKEN;
  state.MODEL = process.env.RUNNER_MODEL || "sonnet";
  state.SYSTEM_PROMPT = process.env.RUNNER_SYSTEM_PROMPT;
  state.APPEND_SYSTEM_PROMPT = process.env.RUNNER_APPEND_SYSTEM_PROMPT;
  state.MAX_TURNS = process.env.RUNNER_MAX_TURNS ? parseInt(process.env.RUNNER_MAX_TURNS, 10) : undefined;
  state.THINKING = process.env.RUNNER_THINKING === "true";
  state.ALLOWED_TOOLS = process.env.RUNNER_ALLOWED_TOOLS ? JSON.parse(process.env.RUNNER_ALLOWED_TOOLS) : [];
  state.DISALLOWED_TOOLS = process.env.RUNNER_DISALLOWED_TOOLS ? JSON.parse(process.env.RUNNER_DISALLOWED_TOOLS) : [];
  state.EFFORT = (process.env.RUNNER_EFFORT as any) || undefined;
  state.COMPACT_INSTRUCTIONS = process.env.RUNNER_COMPACT_INSTRUCTIONS;
  state.PERMISSION_MODE = process.env.RUNNER_PERMISSION_MODE || "bypassPermissions";
  state.MCP_SERVERS = process.env.RUNNER_MCP_SERVERS ? JSON.parse(process.env.RUNNER_MCP_SERVERS) : {};
  state.ALLOWED_PATHS = process.env.RUNNER_ALLOWED_PATHS ? JSON.parse(process.env.RUNNER_ALLOWED_PATHS) : [];
  state.VAULT = process.env.RUNNER_VAULT;
  state.WORKSPACE = "/workspace";
  state.MEM_SOCKET_PATH = process.env.CLAUDE_MEM_SOCKET || "/tmp/claude-mem.sock";
  state.activeCompactInstructions = state.COMPACT_INSTRUCTIONS;

  if (!ORCHESTRATOR_URL) {
    logger.error("runner.config", "RUNNER_ORCHESTRATOR_URL is required");
    process.exit(1);
  }

  logger.info("runner.config", "runner_startup_config", {
    session_id: state.SESSION_ID,
    orchestrator_url: ORCHESTRATOR_URL,
    model: state.MODEL,
    workspace: state.WORKSPACE,
    repo: state.REPO ? "provided" : "none",
    vault: state.VAULT ? "provided" : "none",
    fork_session: FORK_SESSION,
    branch: state.BRANCH,
    ipc_socket: state.MEM_SOCKET_PATH,
    patched_cli: PATCHED_CLI_PATH ? "provided" : "default",
  });
}

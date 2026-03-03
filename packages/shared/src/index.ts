// --- Common Types ---

export type Model = "haiku" | "sonnet" | "sonnet[1m]" | "opus" | "opus[1m]";

/** Content block for multimodal messages (text + images). */
export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type SessionStatus = "starting" | "cloning" | "ready" | "busy" | "idle" | "stopped" | "error";

export type ErrorCode =
  | "invalid_request"
  | "clone_failed"
  | "container_failed"
  | "agent_error"
  | "timeout"
  | "session_capacity_reached"
  | "session_not_found"
  | "session_busy"
  | "session_stopped"
  | "internal";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

// --- API Request Types ---

export interface SessionRequest {
  name?: string;
  pinned?: boolean;
  repo?: string;
  branch?: string;
  workspace?: string;
  vault?: string;
  message?: string;
  model?: Model;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  thinking?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  compactInstructions?: string;
  permissionMode?: string;
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  allowedPaths?: string[];
}

export interface MessageRequest {
  message: string;
  model?: string;
  maxTurns?: number;
}

export interface ForkRequest {
  resumeAt?: string;
  message?: string;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  pinned?: boolean;
}

// --- API Response Types ---

export interface SessionResponse {
  session_id: string;
  result: string;
  usage: Usage;
}

export interface MessageResponse {
  result: string;
  usage: Usage;
}

export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  session_id?: string;
}

export interface SessionInfo {
  session_id: string;
  name?: string;
  pinned?: boolean;
  status: SessionStatus;
  source: {
    type: "repo" | "workspace" | "vault";
    repo?: string;
    branch?: string;
    workspace?: string;
    vault?: string;
  };
  model: string;
  created_at: string;
  last_activity: string;
  message_count: number;
}

export interface SessionDetail extends SessionInfo {
  total_usage: Omit<Usage, "duration_ms">;
  error?: string;
  container_id?: string;
  context_tokens?: number;
  compact_count?: number;
  last_compact_at?: string;
}

// --- Context Types ---

export interface ContextMessage {
  uuid: string;
  parentUuid: string | null;
  type: "user" | "assistant" | "system";
  content: any;
  timestamp?: string;
}

export interface ContextStats {
  message_count: number;
  turn_count: number;
  type_breakdown: Record<string, number>;
  estimated_tokens: number;
}

// --- Runner WS Protocol ---

export interface RunnerEvent {
  type: string;
  [key: string]: any;
}

interface WsCorrelation {
  request_id?: string;
  trace_id?: string;
}

export interface RunnerStatusMessage extends WsCorrelation {
  type: "status";
  session_id: string;
  status: SessionStatus;
}

export interface RunnerEventMessage extends WsCorrelation {
  type: "event";
  session_id: string;
  event: RunnerEvent;
}

export interface RunnerErrorMessage extends WsCorrelation {
  type: "error";
  session_id: string;
  code: string;
  message: string;
}

export interface RunnerSessionInitMessage extends WsCorrelation {
  type: "session_init";
  session_id: string;
  sdk_session_id: string;
}

export interface RunnerContextStateMessage extends WsCorrelation {
  type: "context_state";
  session_id: string;
  context_tokens: number;
  compacted?: boolean;
}

export interface RunnerContextResultMessage extends WsCorrelation {
  type: "context_result";
  session_id: string;
  success: boolean;
  data?: ContextMessage[] | ContextStats | { injected_uuid: string };
  error?: string;
}

export interface RunnerContextSnapshotMessage extends WsCorrelation {
  type: "context_snapshot";
  session_id: string;
  trigger: "steer" | "compact" | "turn_complete" | "manual";
  message_count: number;
  roles: string[];
  messages: any[];
}

export interface RunnerPermissionRequestMessage extends WsCorrelation {
  type: "permission_request";
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  input: any;
}

export type RunnerMessage =
  | RunnerStatusMessage
  | RunnerEventMessage
  | RunnerErrorMessage
  | RunnerSessionInitMessage
  | RunnerContextStateMessage
  | RunnerContextResultMessage
  | RunnerContextSnapshotMessage
  | RunnerPermissionRequestMessage
  | RunnerCommandsResultMessage;

/** Orchestrator → Runner: send a message to the agent */
export interface OrchestratorMessageCommand extends WsCorrelation {
  type: "message";
  message: string;
  /** Multimodal content blocks (text + images). When present, overrides `message`. */
  content?: UserContentBlock[];
  model?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
}

/** Orchestrator → Runner: graceful shutdown */
export interface OrchestratorShutdownCommand {
  type: "shutdown";
}

/** Orchestrator → Runner: trigger compaction on next query */
export interface OrchestratorCompactCommand extends WsCorrelation {
  type: "compact";
  custom_instructions?: string;
}

/** Orchestrator → Runner: JSONL context manipulation */
export type ContextOperation =
  | { op: "get_context" }
  | { op: "remove_message"; uuid: string }
  | { op: "inject_message"; content: string; role: "user" | "system"; after_uuid?: string }
  | { op: "truncate"; keep_last_n: number }
  | { op: "get_stats" };

export interface OrchestratorContextCommand extends WsCorrelation {
  type: "context";
  operation: ContextOperation;
}

/** Orchestrator → Runner: abort current query, optionally edit JSONL, resume with a new message */
export interface OrchestratorSteerCommand extends WsCorrelation {
  type: "steer";
  /** Message to send as the next user turn after aborting */
  message: string;
  /** Multimodal content blocks (text + images). When present, overrides `message`. */
  content?: UserContentBlock[];
  /** Model override for the resumed query */
  model?: string;
  /** Max turns for the resumed query */
  maxTurns?: number;
  /** Max thinking tokens for the resumed query */
  maxThinkingTokens?: number;
  /** If true, force compaction on the resume query */
  compact?: boolean;
  /** Optional custom compact instructions for the resume */
  compact_instructions?: string;
  /** Optional JSONL operations to execute before resuming */
  operations?: ContextOperation[];
}

/** Orchestrator → Runner: fork session, let background finish, handle new message in foreground */
export interface OrchestratorForkAndSteerCommand extends WsCorrelation {
  type: "fork_and_steer";
  /** Message to send as the next user turn in the forked foreground session */
  message: string;
  /** Multimodal content blocks (text + images). When present, overrides `message`. */
  content?: UserContentBlock[];
  /** Model override for the forked session */
  model?: string;
  /** Max turns for the forked session */
  maxTurns?: number;
  /** Max thinking tokens for the forked session */
  maxThinkingTokens?: number;
}

/** Orchestrator → Runner: rewind context to a specific message UUID */
export interface OrchestratorRewindCommand extends WsCorrelation {
  type: "rewind";
  user_message_uuid: string;
}

/** Orchestrator → Runner: dynamically update session options */
export interface OrchestratorSetOptionsCommand extends WsCorrelation {
  type: "set_options";
  model?: string;
  maxThinkingTokens?: number;
  compact_instructions?: string;
}

/** Orchestrator → Runner: respond to a permission request from canUseTool callback */
export interface OrchestratorPermissionResponseCommand extends WsCorrelation {
  type: "permission_response";
  tool_use_id: string;
  behavior: "allow" | "deny" | "allowWithModification";
  message?: string;
  updated_input?: any;
}

/** Orchestrator → Runner: request available slash commands/skills */
export interface OrchestratorGetCommandsCommand extends WsCorrelation {
  type: "get_commands";
}

/** Runner → Orchestrator: available slash commands/skills */
export interface RunnerCommandsResultMessage extends WsCorrelation {
  type: "commands_result";
  session_id: string;
  commands: Array<{ name: string; description: string; argumentHint: string }>;
}

export type OrchestratorCommand =
  | OrchestratorMessageCommand
  | OrchestratorShutdownCommand
  | OrchestratorCompactCommand
  | OrchestratorContextCommand
  | OrchestratorSteerCommand
  | OrchestratorForkAndSteerCommand
  | OrchestratorRewindCommand
  | OrchestratorSetOptionsCommand
  | OrchestratorPermissionResponseCommand
  | OrchestratorGetCommandsCommand;

// --- Context Snapshot Types ---

export interface ContextSnapshotSummary {
  id: number;
  session_id: string;
  request_id?: string;
  trigger: string;
  message_count: number;
  roles: string[];
  created_at: string;
}

export interface ContextSnapshot extends ContextSnapshotSummary {
  messages: any[];
}


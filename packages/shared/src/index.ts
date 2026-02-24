// --- Common Types ---

export type Model = "haiku" | "sonnet" | "opus";

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
    type: "repo" | "workspace";
    repo?: string;
    branch?: string;
    workspace?: string;
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

export type RunnerMessage = RunnerStatusMessage | RunnerEventMessage | RunnerErrorMessage | RunnerSessionInitMessage;

/** Orchestrator → Runner: send a message to the agent */
export interface OrchestratorMessageCommand extends WsCorrelation {
  type: "message";
  message: string;
  model?: string;
  maxTurns?: number;
}

/** Orchestrator → Runner: graceful shutdown */
export interface OrchestratorShutdownCommand {
  type: "shutdown";
}

export type OrchestratorCommand = OrchestratorMessageCommand | OrchestratorShutdownCommand;

// --- SSE Event Types ---

export type SSEEventType =
  | "session"
  | "assistant"
  | "stream_event"
  | "user"
  | "system"
  | "tool_progress"
  | "tool_use_summary"
  | "auth_status"
  | "result"
  | "error";

import type WebSocket from "ws";

// --- API Request/Response Types ---

export interface SessionRequest {
  name?: string;
  repo?: string;
  branch?: string;
  workspace?: string;
  message?: string;
  model?: "haiku" | "sonnet" | "opus";
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

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

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

export type ErrorCode =
  | "invalid_request"
  | "clone_failed"
  | "container_failed"
  | "agent_error"
  | "timeout"
  | "session_not_found"
  | "session_busy"
  | "session_stopped"
  | "internal";

export type SessionStatus = "starting" | "cloning" | "ready" | "busy" | "idle" | "stopped" | "error";

export interface SessionInfo {
  session_id: string;
  name?: string;
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

// --- Internal Session State ---

export interface Session {
  id: string;
  containerId: string;
  status: SessionStatus;
  repo?: string;
  branch?: string;
  workspace?: string;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  totalUsage: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  lastError?: string;
  sdkSessionId?: string;
  forkedFrom?: string;
  name?: string;
  ws?: WebSocket;
  pendingResolve?: (event: RunnerEvent) => void;
}

export interface ForkRequest {
  resumeAt?: string;
  message?: string;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
}

// --- Runner WS Protocol ---

export interface RunnerStatusMessage {
  type: "status";
  session_id: string;
  status: SessionStatus;
}

export interface RunnerEventMessage {
  type: "event";
  session_id: string;
  event: RunnerEvent;
}

export interface RunnerErrorMessage {
  type: "error";
  session_id: string;
  code: string;
  message: string;
}

export interface RunnerSessionInitMessage {
  type: "session_init";
  session_id: string;
  sdk_session_id: string;
}

export type RunnerMessage = RunnerStatusMessage | RunnerEventMessage | RunnerErrorMessage | RunnerSessionInitMessage;

export interface RunnerEvent {
  type: string;
  [key: string]: any;
}

// --- SSE Event Types ---

export type SSEEventType =
  | "session"
  | "assistant"
  | "assistant_delta"
  | "tool"
  | "tool_result"
  | "tool_progress"
  | "thinking"
  | "result"
  | "error";

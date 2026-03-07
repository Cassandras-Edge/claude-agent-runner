// --- Common Types ---

export type Model = "haiku" | "sonnet" | "sonnet[1m]" | "opus" | "opus[1m]";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Content block for multimodal messages. */
export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string };

export type SessionStatus =
  | "starting"
  | "cloning"
  | "syncing"
  | "ready"
  | "busy"
  | "idle"
  | "stopped"
  | "error";

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

export interface SessionSource {
  type: "repo" | "workspace" | "vault" | "ephemeral";
  repo?: string;
  branch?: string;
  workspace?: string;
  vault?: string;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

// --- REST API Types ---

export interface SessionRequest {
  name?: string;
  pinned?: boolean;
  agentId?: string;
  repo?: string;
  branch?: string;
  workspace?: string;
  vault?: string;
  message?: string;
  model?: Model | string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  thinking?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  compactInstructions?: string;
  permissionMode?: string;
  mcpServers?: Record<string, McpServerConfig>;
  allowedPaths?: string[];
}

export interface CreateSessionResponse {
  session_id: string;
  status?: SessionStatus;
  result?: string;
  usage?: Usage;
}

export interface MessageRequest {
  message: string;
  model?: string;
  maxTurns?: number;
}

export interface MessageResponse {
  result: string;
  usage: Usage;
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

export interface ForkResponse {
  session_id: string;
  result?: string;
  usage?: Usage;
}

export interface StopSessionResponse {
  session_id: string;
  status: SessionStatus;
  total_usage: Omit<Usage, "duration_ms">;
}

export interface ResumeSessionResponse {
  session_id: string;
  status?: SessionStatus;
  resumed?: boolean;
}

export interface GenerateTitleRequest {
  userMessage: string;
  assistantMessage?: string;
}

export interface GenerateTitleResponse {
  title: string;
}

export interface SuggestFolderRequest {
  title: string;
  preview: string;
  folders: string[];
}

export interface SuggestFolderResponse {
  type: "existing" | "new";
  folderName: string;
}

export interface RestorableSessionConfig {
  vaultName?: string;
  agentId?: string;
  thinking?: boolean;
  additionalDirectories?: string[];
  compactInstructions?: string;
  permissionMode?: string;
  mcpServers?: Record<string, McpServerConfig>;
  allowedPaths?: string[];
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
  agent_id?: string;
  status: SessionStatus;
  source: SessionSource;
  model: string;
  created_at: string;
  last_activity: string;
  message_count: number;
}

export interface SessionDetail extends SessionInfo {
  total_usage?: Omit<Usage, "duration_ms">;
  error?: string;
  container_id?: string;
  sdk_session_id?: string;
  forked_from?: string;
  context_tokens?: number;
  compact_count?: number;
  last_compact_at?: string;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
}

export interface TranscriptResponse<TEvent = unknown> {
  session_id: string;
  events: TEvent[];
}

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

export interface ContextResponse {
  session_id: string;
  messages: ContextMessage[];
  stats?: ContextStats;
  context_tokens?: number;
  compact_count?: number;
  last_compact_at?: string;
}

export interface ContextCompactRequest {
  custom_instructions?: string;
}

export interface ContextCompactResponse {
  session_id: string;
  scheduled: boolean;
  message: string;
}

export interface ContextInjectRequest {
  content: string;
  role: "user" | "system";
  after_uuid?: string;
}

export interface ContextTruncateRequest {
  keep_last_n: number;
}

export interface SessionUpdateRequest {
  name?: string;
  pinned?: boolean;
}

export interface SessionUpdateResponse {
  session_id: string;
  name?: string;
  pinned?: boolean;
}

export interface HealthInfo {
  status: "ok";
  active_sessions: number;
  token_pool: {
    size: number;
    usage: Array<{ tokenIndex: number; activeSessions: number }>;
  };
  uptime_ms: number;
  runner_image: string;
  docker_connected: boolean;
  max_active_sessions: number | null;
  warm_pool: unknown;
}

export interface TenantInfo {
  id: string;
  name: string;
  namespace: string;
  max_sessions: number;
  created_at: string;
  updated_at?: string;
  vault?: string;
  has_obsidian_auth?: boolean;
  has_git_token?: boolean;
}

export interface TenantListResponse {
  tenants: TenantInfo[];
}

export interface CreateTenantRequest {
  id: string;
  name: string;
  namespace?: string;
  max_sessions?: number;
  vault?: string;
  obsidian_auth_token?: string;
  obsidian_e2ee_password?: string;
  git_token?: string;
}

export interface CreateTenantResponse extends TenantInfo {
  api_key: string;
}

export interface UpdateTenantRequest {
  name?: string;
  max_sessions?: number;
  vault?: string | null;
  obsidian_auth_token?: string | null;
  obsidian_e2ee_password?: string | null;
  git_token?: string | null;
}

export interface RotateTenantKeyResponse {
  id: string;
  api_key: string;
}

// --- Shared WebSocket Correlation ---

export interface WsCorrelation {
  request_id?: string;
  trace_id?: string;
}

// --- Runner <-> Orchestrator WS Protocol ---

export interface RunnerEvent {
  type: string;
  [key: string]: any;
}

export interface StatusFrame extends WsCorrelation {
  type: "status";
  session_id: string;
  status: SessionStatus;
}

export interface EventFrame extends WsCorrelation {
  type: "event";
  session_id: string;
  event: RunnerEvent;
}

export interface RunnerErrorMessage extends WsCorrelation {
  type: "error";
  session_id: string;
  code?: string;
  error_code?: string;
  message: string;
}

export interface RunnerSessionInitMessage extends WsCorrelation {
  type: "session_init";
  session_id: string;
  sdk_session_id: string;
}

export interface ContextStateFrame extends WsCorrelation {
  type: "context_state";
  session_id: string;
  context_tokens: number;
  compacted?: boolean;
}

export interface RunnerContextResultMessage extends WsCorrelation {
  type: "context_result";
  session_id: string;
  success: boolean;
  data?: ContextMessage[] | ContextStats | { injected_uuid: string } | { injected: true } | { messages_removed: number };
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

export interface PermissionRequestFrame extends WsCorrelation {
  type: "permission_request";
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  input: any;
}

export interface RunnerUtilityQueryResultMessage extends WsCorrelation {
  type: "utility_query_result";
  session_id: string;
  text?: string;
  error?: string;
}

export interface CommandsResultFrame extends WsCorrelation {
  type: "commands_result";
  session_id: string;
  commands: SlashCommandInfo[];
}

export interface RunnerBackgroundCompleteMessage {
  type: "background_complete";
  session_id: string;
  task_id: string;
  success: boolean;
  error?: string;
}

export type RunnerMessage =
  | StatusFrame
  | EventFrame
  | RunnerErrorMessage
  | RunnerSessionInitMessage
  | ContextStateFrame
  | RunnerContextResultMessage
  | RunnerContextSnapshotMessage
  | PermissionRequestFrame
  | RunnerUtilityQueryResultMessage
  | CommandsResultFrame
  | RunnerBackgroundCompleteMessage;

/** Orchestrator -> Runner: send a message to the agent */
export interface OrchestratorMessageCommand extends WsCorrelation {
  type: "message";
  message: string;
  content?: UserContentBlock[];
  model?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
}

/** Orchestrator -> Runner: graceful shutdown */
export interface OrchestratorShutdownCommand {
  type: "shutdown";
}

/** Orchestrator -> Runner: trigger compaction on next query */
export interface OrchestratorCompactCommand extends WsCorrelation {
  type: "compact";
  custom_instructions?: string;
}

/** Orchestrator -> Runner: JSONL/IPC context manipulation */
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

export interface OrchestratorSteerCommand extends WsCorrelation {
  type: "steer";
  message: string;
  content?: UserContentBlock[];
  model?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
  compact?: boolean;
  compact_instructions?: string;
  operations?: ContextOperation[];
}

export interface OrchestratorForkAndSteerCommand extends WsCorrelation {
  type: "fork_and_steer";
  message: string;
  content?: UserContentBlock[];
  model?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
}

export interface OrchestratorRewindCommand extends WsCorrelation {
  type: "rewind";
  user_message_uuid: string;
}

export interface OrchestratorSetOptionsCommand extends WsCorrelation {
  type: "set_options";
  model?: string;
  maxThinkingTokens?: number;
  compact_instructions?: string;
  permission_mode?: string;
}

export interface OrchestratorPermissionResponseCommand extends WsCorrelation {
  type: "permission_response";
  tool_use_id: string;
  behavior: "allow" | "deny" | "allowWithModification";
  message?: string;
  updated_input?: any;
}

export interface OrchestratorGetCommandsCommand extends WsCorrelation {
  type: "get_commands";
}

export interface OrchestratorUtilityQueryCommand extends WsCorrelation {
  type: "utility_query";
  prompt: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
}

export interface OrchestratorAdoptCommand {
  type: "adopt";
  session_id: string;
  oauth_token: string;
  config: {
    repo?: string;
    branch?: string;
    gitToken?: string;
    vault?: string;
    model?: string;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    maxTurns?: number;
    thinking?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
    compactInstructions?: string;
    permissionMode?: string;
    mcpServers?: Record<string, McpServerConfig>;
    allowedPaths?: string[];
  };
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
  | OrchestratorGetCommandsCommand
  | OrchestratorAdoptCommand
  | OrchestratorUtilityQueryCommand;

// --- Client <-> Orchestrator WS Protocol ---

export interface SubscribeFrame {
  type: "subscribe";
  session_id: string;
  request_id?: string;
}

export interface UnsubscribeFrame {
  type: "unsubscribe";
  session_id: string;
}

export interface SendFrame {
  type: "send";
  session_id: string;
  message: string;
  content?: UserContentBlock[];
  model?: string;
  max_turns?: number;
  max_thinking_tokens?: number;
  request_id?: string;
}

export interface SteerFrame {
  type: "steer";
  session_id: string;
  message: string;
  content?: UserContentBlock[];
  mode?: "steer" | "fork_and_steer";
  model?: string;
  max_turns?: number;
  max_thinking_tokens?: number;
  compact?: boolean;
  compact_instructions?: string;
  operations?: ContextOperation[];
  request_id?: string;
}

export interface CompactFrame {
  type: "compact";
  session_id: string;
  custom_instructions?: string;
  request_id?: string;
}

export interface PermissionResponseFrame extends WsCorrelation {
  type: "permission_response";
  session_id: string;
  tool_use_id: string;
  behavior: "allow" | "deny" | "allowWithModification";
  message?: string;
  updated_input?: any;
}

export interface RewindFrame {
  type: "rewind";
  session_id: string;
  user_message_uuid: string;
  request_id?: string;
}

export interface SetOptionsFrame {
  type: "set_options";
  session_id: string;
  model?: string;
  max_thinking_tokens?: number;
  compact_instructions?: string;
  permission_mode?: string;
  request_id?: string;
}

export interface GetCommandsFrame {
  type: "get_commands";
  session_id: string;
  request_id?: string;
}

export interface PingFrame {
  type: "ping";
}

export type ClientFrame =
  | SubscribeFrame
  | UnsubscribeFrame
  | SendFrame
  | SteerFrame
  | CompactFrame
  | PermissionResponseFrame
  | RewindFrame
  | SetOptionsFrame
  | GetCommandsFrame
  | PingFrame;

export interface AckFrame {
  type: "ack";
  session_id: string;
  ok: boolean;
  error?: string;
  request_id?: string;
}

export interface ErrorFrame extends WsCorrelation {
  type: "error";
  session_id?: string;
  error_code?: string;
  message?: string;
}

export interface SubscribedFrame extends WsCorrelation {
  type: "subscribed";
  session_id: string;
  status?: SessionStatus;
}

export interface PongFrame {
  type: "pong";
}

export type ServerFrame =
  | AckFrame
  | StatusFrame
  | EventFrame
  | ContextStateFrame
  | PermissionRequestFrame
  | CommandsResultFrame
  | ErrorFrame
  | SubscribedFrame
  | PongFrame;

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

// --- Compatibility Aliases ---

export type RunnerStatusMessage = StatusFrame;
export type RunnerEventMessage = EventFrame;
export type RunnerErrorFrame = ErrorFrame;
export type RunnerContextStateMessage = ContextStateFrame;
export type RunnerPermissionRequestMessage = PermissionRequestFrame;
export type RunnerCommandsResultMessage = CommandsResultFrame;

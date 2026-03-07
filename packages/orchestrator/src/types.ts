import type WebSocket from "ws";
import type { SessionStatus, RunnerEvent } from "@bugcat/claude-agent-runner-shared";

// Re-export everything from shared so existing imports from "./types.js" keep working
export type {
  Model,
  SessionStatus,
  ErrorCode,
  Usage,
  RestorableSessionConfig,
  SessionRequest,
  MessageRequest,
  ForkRequest,
  CreateSessionResponse,
  MessageResponse,
  ErrorResponse,
  SessionInfo,
  SessionDetail,
  RunnerEvent,
  RunnerStatusMessage,
  RunnerEventMessage,
  RunnerErrorMessage,
  RunnerSessionInitMessage,
  RunnerMessage,
  OrchestratorCommand,
  OrchestratorMessageCommand,
  OrchestratorShutdownCommand,
  OrchestratorCompactCommand,
  OrchestratorContextCommand,
  ContextOperation,
  RunnerContextStateMessage,
  RunnerContextResultMessage,
  ContextMessage,
  ContextStats,
  RunnerContextSnapshotMessage,
  RunnerUtilityQueryResultMessage,
  ContextSnapshotSummary,
  ContextSnapshot,
} from "@bugcat/claude-agent-runner-shared";

// --- Internal Session State (orchestrator-only) ---

export interface Session {
  id: string;
  containerId: string;
  status: SessionStatus;
  repo?: string;
  branch?: string;
  workspace?: string;
  vaultName?: string;
  agentId?: string;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  thinking?: boolean;
  additionalDirectories?: string[];
  compactInstructions?: string;
  permissionMode?: string;
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  allowedPaths?: string[];
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
  pinned: boolean;
  contextTokens: number;
  compactCount: number;
  lastCompactAt?: Date;
  tenantId?: string;
  ws?: WebSocket;
  pendingResolve?: (event: RunnerEvent) => void;
}

export interface SessionCreateConfig {
  name?: string;
  pinned?: boolean;
  repo?: string;
  branch?: string;
  workspace?: string;
  vaultName?: string;
  agentId?: string;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  thinking?: boolean;
  additionalDirectories?: string[];
  compactInstructions?: string;
  permissionMode?: string;
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  allowedPaths?: string[];
  forkedFrom?: string;
  tenantId?: string;
}

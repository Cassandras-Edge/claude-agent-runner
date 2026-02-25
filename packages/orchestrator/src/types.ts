import type WebSocket from "ws";
import type { SessionStatus, RunnerEvent } from "@claude-agent-runner/shared";

// Re-export everything from shared so existing imports from "./types.js" keep working
export type {
  Model,
  SessionStatus,
  ErrorCode,
  Usage,
  SessionRequest,
  MessageRequest,
  ForkRequest,
  SessionResponse,
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
  SSEEventType,
} from "@claude-agent-runner/shared";

// --- Internal Session State (orchestrator-only) ---

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
  pinned: boolean;
  contextTokens: number;
  compactCount: number;
  lastCompactAt?: Date;
  ws?: WebSocket;
  pendingResolve?: (event: RunnerEvent) => void;
}

import type { SDKSession } from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcess } from "child_process";
import type { DrainResult } from "./background-drainer.js";
import type { MemIpcClient } from "./mem-ipc.js";

export type BackgroundSession = {
  sdkSessionId: string;
  taskId: string;
  toolUseSummary: string;
  drainPromise: Promise<DrainResult>;
};

export const state = {
  SESSION_ID: "",
  REPO: undefined as string | undefined,
  BRANCH: "main",
  GIT_TOKEN: undefined as string | undefined,
  MODEL: "sonnet",
  SYSTEM_PROMPT: undefined as string | undefined,
  APPEND_SYSTEM_PROMPT: undefined as string | undefined,
  MAX_TURNS: undefined as number | undefined,
  THINKING: false,
  ALLOWED_TOOLS: [] as string[],
  DISALLOWED_TOOLS: [] as string[],
  COMPACT_INSTRUCTIONS: undefined as string | undefined,
  PERMISSION_MODE: "bypassPermissions",
  MCP_SERVERS: {} as Record<string, { type: "http" | "sse"; url: string; headers?: Record<string, string> }>,
  ALLOWED_PATHS: [] as string[],
  VAULT: undefined as string | undefined,
  WORKSPACE: "/workspace",
  MEM_SOCKET_PATH: "/tmp/claude-mem.sock",

  sdkSessionId: undefined as string | undefined,
  session: null as SDKSession | null,
  ipc: null as MemIpcClient | null,
  setupCompleted: false,
  isBusy: false,
  forceCompactOnNextQuery: false,
  pendingCompactInstructions: undefined as string | undefined,
  activeCompactInstructions: undefined as string | undefined,
  activeResponse: null as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query> | null,
  vaultSyncProcess: null as ChildProcess | null,

  pendingSteer: null as {
    message: string;
    content?: any[];
    model?: string;
    maxTurns?: number;
    maxThinkingTokens?: number;
    requestId?: string;
    traceId?: string;
    compact?: boolean;
    compactInstructions?: string;
    operations?: import("@bugcat/claude-agent-runner-shared").ContextOperation[];
  } | null,

  pendingForkAndSteer: null as {
    message: string;
    content?: any[];
    model?: string;
    maxTurns?: number;
    maxThinkingTokens?: number;
    requestId?: string;
    traceId?: string;
  } | null,

  backgroundSessions: new Map<string, BackgroundSession>(),
  pendingPermissionRequests: new Map<
    string,
    (result: { behavior: string; message?: string; updatedInput?: any }) => void
  >(),
};

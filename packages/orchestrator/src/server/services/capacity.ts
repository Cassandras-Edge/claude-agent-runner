import type { ErrorCode } from "../../types.js";
import { logger } from "../../logger.js";
import type { AppContext } from "../app-context.js";
import { stopSessionRuntime } from "./session-runtime.js";

export interface ApiError extends Error {
  code: ErrorCode;
  status: number;
}

export function createApiError(code: ErrorCode, status: number, message: string): ApiError {
  const err = new Error(message) as ApiError;
  err.code = code;
  err.status = status;
  return err;
}

export function isApiError(err: unknown): err is ApiError {
  if (!(err instanceof Error)) return false;
  const maybe = err as Partial<ApiError>;
  return typeof maybe.code === "string" && typeof maybe.status === "number";
}

async function stopSessionForCapacity(ctx: AppContext, sessionId: string): Promise<void> {
  logger.info("orchestrator.capacity", "evicting_session", { session_id: sessionId });
  await stopSessionRuntime(ctx, sessionId);
}

export async function ensureCapacity(ctx: AppContext): Promise<void> {
  if (!ctx.maxActiveSessions) return;

  let active = ctx.sessions.activeCount();
  if (active < ctx.maxActiveSessions) return;
  logger.warn("orchestrator.capacity", "max_active_sessions_reached", {
    active_sessions: active,
    max_active_sessions: ctx.maxActiveSessions,
  });

  const evictable = ctx.sessions.evictableByLru();
  logger.debug("orchestrator.capacity", "evictable_sessions", { count: evictable.length });

  for (const session of evictable) {
    if (active < ctx.maxActiveSessions) break;
    logger.debug("orchestrator.capacity", "evicting_next_session", {
      session_id: session.id,
      last_activity: session.lastActivity.toISOString(),
    });
    await stopSessionForCapacity(ctx, session.id);
    active = ctx.sessions.activeCount();
  }

  if (active >= ctx.maxActiveSessions) {
    logger.error("orchestrator.capacity", "capacity_critical", {
      active_sessions: active,
      max_active_sessions: ctx.maxActiveSessions,
      evictable_count: evictable.length,
    });
    throw createApiError(
      "session_capacity_reached",
      429,
      `Max active sessions (${ctx.maxActiveSessions}) reached; no evictable ready/idle sessions available`,
    );
  }
}

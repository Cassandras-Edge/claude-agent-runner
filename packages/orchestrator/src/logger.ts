import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogContext {
  traceId?: string;
  requestId?: string;
  sessionId?: string;
}

interface LogMeta {
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(value: string | undefined): LogLevel {
  const normalized = (value || "").toLowerCase();
  if (normalized === "error" || normalized === "warn" || normalized === "info" || normalized === "debug") {
    return normalized;
  }
  return "info";
}

const CURRENT_LEVEL = normalizeLevel(process.env.LOG_LEVEL);
const contextStore = new AsyncLocalStorage<LogContext>();

function currentContext(): LogContext | undefined {
  return contextStore.getStore();
}

export function runWithLogContext<T>(context: LogContext, fn: () => T | Promise<T>): T | Promise<T> {
  return contextStore.run(context, fn);
}

export function withLogContext<T>(context: LogContext, fn: () => T | Promise<T>): T | Promise<T> {
  return contextStore.run(context, fn);
}

export function getLogContext(): LogContext | undefined {
  return currentContext();
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[CURRENT_LEVEL];
}

function emit(level: LogLevel, scope: string, message: string, meta?: LogMeta): void {
  if (!shouldLog(level)) return;
  const context = currentContext() || {};

  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context.traceId ? { trace_id: context.traceId } : {}),
    ...(context.requestId ? { request_id: context.requestId } : {}),
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
    ...(meta ? { meta } : {}),
  };
  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  error(scope: string, message: string, meta?: LogMeta): void {
    emit("error", scope, message, meta);
  },
  warn(scope: string, message: string, meta?: LogMeta): void {
    emit("warn", scope, message, meta);
  },
  info(scope: string, message: string, meta?: LogMeta): void {
    emit("info", scope, message, meta);
  },
  debug(scope: string, message: string, meta?: LogMeta): void {
    emit("debug", scope, message, meta);
  },
};

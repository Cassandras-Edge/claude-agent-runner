import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import type { Context } from "hono";
import type {
  ErrorResponse,
  MessageRequest,
  RunnerEvent,
  SessionRequest,
  Usage,
} from "../../types.js";
import { getLogContext, logger } from "../../logger.js";
import * as metrics from "../../metrics.js";
import type { SessionManager } from "../../sessions.js";
import type { Session } from "../../types.js";
import type { AppContext } from "../app-context.js";

export function getSessionSource(session: Pick<Session, "repo" | "branch" | "workspace" | "vaultName">) {
  return {
    type: session.repo ? "repo" as const : session.vaultName ? "vault" as const : session.workspace ? "workspace" as const : "ephemeral" as const,
    ...(session.repo ? { repo: session.repo, branch: session.branch } : {}),
    ...(session.workspace ? { workspace: session.workspace } : {}),
    ...(session.vaultName ? { vault: session.vaultName } : {}),
  };
}

export async function parseSessionRequest(
  c: Context,
  sessions?: SessionManager,
  tenantId?: string,
): Promise<SessionRequest | { error: ErrorResponse; status: any }> {
  let body: SessionRequest;
  try {
    body = (await c.req.json()) as SessionRequest;
  } catch {
    logger.warn("orchestrator.api", "invalid_json", { endpoint: "parseSessionRequest" });
    return { error: { code: "invalid_request", message: "Invalid JSON body" }, status: 400 };
  }

  if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
    logger.warn("orchestrator.api", "invalid_pinned_payload", { pinned: body.pinned });
    return { error: { code: "invalid_request", message: "Field pinned must be a boolean" }, status: 400 };
  }

  if (body.name && sessions?.nameExists(body.name.trim(), tenantId)) {
    logger.warn("orchestrator.api", "duplicate_session_name", { name: body.name.trim() });
    return { error: { code: "invalid_request", message: `Session name "${body.name.trim()}" is already in use` }, status: 409 };
  }

  return body;
}

/**
 * Fetch per-tenant credentials from the Auth service and merge into the session env.
 *
 * Auth store layout:
 *   cred:{email}:runner          → { OBSIDIAN_AUTH_TOKEN }  (account-level)
 *   cred:{email}:runner:{vault}  → { OBSIDIAN_E2EE_PASSWORD }  (per-vault)
 *
 * Falls back gracefully: if no Auth client, no tenant, or no email, returns the env unchanged.
 */
/**
 * Fetch per-tenant credentials from the auth store.
 *
 * Auth store layout:
 *   cred:{email}:runner          → { OBSIDIAN_AUTH_TOKEN }  (account-level)
 *   cred:{email}:runner:{vault}  → { OBSIDIAN_E2EE_PASSWORD }  (per-vault)
 *
 * Returns credentials as a separate map (not merged into process.env)
 * so they bypass the FORWARDED_RUNNER_ENV_KEYS allowlist.
 */
export async function resolveCredentials(
  ctx: AppContext,
  tenantId?: string,
  vaultName?: string,
): Promise<Record<string, string>> {
  if (!ctx.authClient || !tenantId || !ctx.tenants) return {};

  const tenant = ctx.tenants.get(tenantId);
  if (!tenant?.email) return {};

  const fetches: Promise<Record<string, string> | null>[] = [
    ctx.authClient.fetchCredentials(tenant.email, "runner"),
  ];
  if (vaultName) {
    fetches.push(ctx.authClient.fetchCredentials(tenant.email, `runner:${vaultName}`));
  }

  const [accountCreds, vaultCreds] = await Promise.all(fetches);

  return { ...accountCreds, ...vaultCreds };
}

export async function spawnSession(
  ctx: AppContext,
  sessionId: string,
  body: SessionRequest,
  requestId?: string,
  tenantId?: string,
) {
  const model = body.model || "sonnet";
  const maxTurns = body.maxTurns;
  logger.info("orchestrator.session", "spawn_session", {
    session_id: sessionId,
    model,
    repo: body.repo,
    workspace: body.workspace,
    vault: body.vault,
    branch: body.branch,
    request_id: requestId,
  });

  const canUseWarmPool = ctx.warmPool && !body.workspace && !body.additionalDirectories?.length;
  if (canUseWarmPool) {
    const warmEntry = ctx.warmPool!.adopt(body.vault, body.agentId);
    if (warmEntry) {
      ctx.tokenPool.release(warmEntry.warmId);
      const { token, tokenIndex } = ctx.tokenPool.assign(sessionId);
      const warmCredentials = await resolveCredentials(ctx, tenantId, body.vault);

      const adoptConfig = {
        repo: body.repo,
        branch: body.branch,
        gitToken: ctx.env.GIT_TOKEN || ctx.env.GITHUB_TOKEN,
        vault: body.vault,
        model,
        systemPrompt: body.systemPrompt,
        appendSystemPrompt: body.appendSystemPrompt,
        maxTurns,
        thinking: body.thinking,
        allowedTools: body.allowedTools,
        disallowedTools: body.disallowedTools,
        compactInstructions: body.compactInstructions,
        permissionMode: body.permissionMode,
        mcpServers: body.mcpServers,
        allowedPaths: body.allowedPaths,
        credentials: warmCredentials,
      };

      ctx.bridge.sendAdopt(warmEntry.warmId, sessionId, token, adoptConfig);
      ctx.bridge.rekeyConnection(warmEntry.warmId, sessionId);
      ctx.docker.rekeySession(warmEntry.warmId, sessionId);

      const session = ctx.sessions.create(sessionId, warmEntry.containerId, tokenIndex, {
        name: body.name?.trim(),
        pinned: body.pinned,
        repo: body.repo,
        branch: body.branch,
        workspace: body.workspace,
        vaultName: body.vault,
        agentId: body.agentId,
        model,
        systemPrompt: body.systemPrompt,
        maxTurns,
        thinking: body.thinking,
        additionalDirectories: body.additionalDirectories,
        compactInstructions: body.compactInstructions,
        permissionMode: body.permissionMode,
        mcpServers: body.mcpServers,
        allowedPaths: body.allowedPaths,
        tenantId,
      });

      metrics.warmPoolHitsTotal.inc();
      const sourceType = body.repo ? "repo" : body.vault ? "vault" : body.workspace ? "workspace" : "ephemeral";
      metrics.sessionsCreatedTotal.inc({ model, source_type: sourceType, tenant_id: tenantId || "" });

      logger.info("orchestrator.session", "session_adopted_from_warm_pool", {
        session_id: sessionId,
        warm_id: warmEntry.warmId,
        request_id: requestId,
      });
      return { session, containerId: warmEntry.containerId };
    }
  }

  const { token, tokenIndex } = ctx.tokenPool.assign(sessionId);
  const credentialsEnv = await resolveCredentials(ctx, tenantId, body.vault);
  const sessionEnv = { ...ctx.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  let containerId: string | undefined;

  try {
    containerId = await ctx.docker.spawn({
      sessionId,
      image: ctx.runnerImage,
      orchestratorUrl: ctx.orchestratorWsUrl,
      env: sessionEnv,
      credentialsEnv,
      network: ctx.network,
      sessionsVolume: ctx.sessionsVolume,
      vault: body.vault,
      repo: body.repo,
      branch: body.branch,
      workspace: body.workspace,
      model,
      systemPrompt: body.systemPrompt,
      appendSystemPrompt: body.appendSystemPrompt,
      maxTurns,
      thinking: body.thinking,
      allowedTools: body.allowedTools,
      disallowedTools: body.disallowedTools,
      additionalDirectories: body.additionalDirectories,
      compactInstructions: body.compactInstructions,
      permissionMode: body.permissionMode,
      mcpServers: body.mcpServers,
      allowedPaths: body.allowedPaths,
    });

    const session = ctx.sessions.create(sessionId, containerId, tokenIndex, {
      name: body.name?.trim(),
      pinned: body.pinned,
      repo: body.repo,
      branch: body.branch,
      workspace: body.workspace,
      vaultName: body.vault,
      agentId: body.agentId,
      model,
      systemPrompt: body.systemPrompt,
      maxTurns,
      thinking: body.thinking,
      additionalDirectories: body.additionalDirectories,
      compactInstructions: body.compactInstructions,
      permissionMode: body.permissionMode,
      mcpServers: body.mcpServers,
      allowedPaths: body.allowedPaths,
      tenantId,
    });

    metrics.warmPoolMissesTotal.inc();
    const sourceType = body.repo ? "repo" : body.vault ? "vault" : body.workspace ? "workspace" : "ephemeral";
    metrics.sessionsCreatedTotal.inc({ model, source_type: sourceType, tenant_id: tenantId || "" });

    logger.debug("orchestrator.session", "session_db_record_created", { session_id: sessionId, request_id: requestId });
    return { session, containerId };
  } catch (err) {
    logger.error("orchestrator.session", "spawn_session_failed", {
      session_id: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (containerId) {
      await ctx.docker.kill(sessionId).catch(() => undefined);
    }
    ctx.tokenPool.release(sessionId);
    throw err;
  }
}

export function waitForReady(ctx: AppContext, sessionId: string, timeoutMs = 120_000, requestId?: string): Promise<void> {
  const session = ctx.sessions.get(sessionId);
  if (session?.status === "ready") return Promise.resolve();
  logger.debug("orchestrator.session", "wait_for_ready", {
    session_id: sessionId,
    timeout_ms: timeoutMs,
    request_id: requestId,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logger.warn("orchestrator.session", "wait_for_ready_timeout", {
        session_id: sessionId,
        request_id: requestId,
      });
      cleanup();
      reject(new Error("Timed out waiting for runner to be ready"));
    }, timeoutMs);

    const onStatus = (status: string) => {
      logger.debug("orchestrator.session", "wait_for_ready_status", { session_id: sessionId, status, request_id: requestId });
      if (status === "ready") { cleanup(); resolve(); }
    };
    const onError = (_code: string, message: string) => {
      logger.warn("orchestrator.session", "wait_for_ready_error", { session_id: sessionId, code: _code, message, request_id: requestId });
      cleanup();
      reject(new Error(message));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ctx.bridge.removeListener(`status:${sessionId}`, onStatus);
      ctx.bridge.removeListener(`error:${sessionId}`, onError);
    };

    ctx.bridge.on(`status:${sessionId}`, onStatus);
    ctx.bridge.on(`error:${sessionId}`, onError);
  });
}

export function sendAndCollect(
  ctx: AppContext,
  sessionId: string,
  message: string,
  overrides?: { model?: string; maxTurns?: number; requestId?: string },
): Promise<{ text: string; usage: Usage }> {
  logger.debug("orchestrator.session", "send_and_collect", {
    session_id: sessionId,
    model: overrides?.model,
    max_turns: overrides?.maxTurns,
    message_len: message.length,
    request_id: overrides?.requestId,
  });
  return new Promise((resolve, reject) => {
    let text = "";
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 };
    const requestId = overrides?.requestId;
    const traceId = getLogContext()?.traceId;
    const timeout = setTimeout(() => {
      logger.warn("orchestrator.session", "send_and_collect_timeout", {
        session_id: sessionId,
        timeout_ms: ctx.messageTimeoutMs,
        request_id: requestId,
      });
      cleanup();
      reject(new Error(`Timed out waiting for runner result after ${ctx.messageTimeoutMs}ms`));
    }, ctx.messageTimeoutMs);

    const onEvent = (event: RunnerEvent) => {
      if (event.type === "assistant") {
        const blocks = Array.isArray(event.content) ? event.content : [];
        text += blocks
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
      } else if (event.type === "result") {
        cleanup();
        usage.input_tokens = event.usage?.input_tokens || 0;
        usage.output_tokens = event.usage?.output_tokens || 0;
        usage.cost_usd = event.usage?.cost_usd || 0;
        usage.duration_ms = event.usage?.duration_ms || 0;
        ctx.sessions.addUsage(sessionId, usage);
        if (event.subtype === "success") {
          logger.info("orchestrator.session", "send_and_collect_result", {
            session_id: sessionId,
            usage,
            request_id: requestId,
          });
          resolve({ text: event.result || text, usage });
        } else {
          logger.warn("orchestrator.session", "send_and_collect_result_error", {
            session_id: sessionId,
            subtype: event.subtype,
            errors: event.errors,
            request_id: requestId,
          });
          reject(new Error(event.errors?.join(", ") || "Agent execution failed"));
        }
      }
    };
    const onError = (_code: string, message: string) => {
      logger.warn("orchestrator.session", "send_and_collect_error", { session_id: sessionId, code: _code, message, request_id: requestId });
      cleanup();
      reject(new Error(message));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ctx.bridge.removeListener(`event:${sessionId}`, onEvent);
      ctx.bridge.removeListener(`error:${sessionId}`, onError);
    };

    ctx.bridge.on(`event:${sessionId}`, onEvent);
    ctx.bridge.on(`error:${sessionId}`, onError);

    const sent = ctx.bridge.sendMessage(sessionId, message, {
      ...overrides,
      requestId,
      traceId,
    });
    if (!sent) {
      cleanup();
      reject(new Error("Runner not connected"));
    }
  });
}

export function categorizeError(message: string): string {
  if (message.includes("clone") || message.includes("git") || message.includes("Authentication")) return "clone_failed";
  if (message.includes("container") || message.includes("Container")) return "container_failed";
  if (message.includes("timeout") || message.includes("Timed out")) return "timeout";
  return "internal";
}

export async function rollbackSession(ctx: AppContext, sessionId: string, requestId?: string): Promise<void> {
  logger.warn("orchestrator.session", "rollback_session", { session_id: sessionId, request_id: requestId });
  ctx.bridge.sendShutdown(sessionId);
  await ctx.docker.kill(sessionId).catch(() => undefined);
  ctx.sessions.remove(sessionId);
  ctx.tokenPool.release(sessionId);
}

export async function stopSessionRuntime(ctx: AppContext, sessionId: string): Promise<void> {
  ctx.bridge.sendShutdown(sessionId);
  await ctx.docker.kill(sessionId).catch(() => undefined);
  ctx.sessions.clearRuntime(sessionId);
  ctx.sessions.updateStatus(sessionId, "stopped");
  ctx.tokenPool.release(sessionId);
}

export async function getTranscriptResponse(ctx: AppContext, sessionId: string, format?: string) {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    logger.warn("orchestrator.api", "session_not_found", { session_id: sessionId, context: "transcript" });
    return { kind: "error" as const, body: { code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, status: 404 };
  }

  // Transcript JSONL files are named by SDK session ID, not orchestrator session ID
  const transcriptId = session.sdkSessionId || session.id;
  const transcriptPath = join(ctx.sessionsPath, "projects", "-workspace", `${transcriptId}.jsonl`);
  if (!existsSync(transcriptPath)) {
    logger.debug("orchestrator.api", "transcript_not_found", { session_id: session.id, sdk_session_id: session.sdkSessionId, path: transcriptPath });
    return { kind: "error" as const, body: { code: "session_not_found", message: "Transcript not yet available" } satisfies ErrorResponse, status: 404 };
  }

  const raw = await readFile(transcriptPath, "utf-8");
  if (format === "json") {
    const lines = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { kind: "json" as const, body: { session_id: session.id, events: lines } };
  }

  return {
    kind: "raw" as const,
    response: new Response(raw, {
      headers: { "Content-Type": "application/x-ndjson", "X-Session-Id": session.id },
    }),
  };
}

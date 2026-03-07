import { randomUUID } from "crypto";
import type { Hono } from "hono";
import { logger } from "../../logger.js";
import type { ErrorResponse } from "../../types.js";
import type { AppContext } from "../app-context.js";
import {
  buildFolderPrompt,
  buildTitlePrompt,
  FOLDER_SUGGESTION_SYSTEM_PROMPT,
  parseFolderSuggestion,
  parseTitle,
  TITLE_GENERATION_SYSTEM_PROMPT,
} from "../services/utility-prompts.js";

export function registerUtilityRoutes(app: Hono, ctx: AppContext): void {
  app.post("/sessions/:id/generate-title", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    let body: { userMessage: string; assistantMessage?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }

    if (!body.userMessage?.trim()) {
      return c.json({ code: "invalid_request", message: "userMessage is required" } satisfies ErrorResponse, 400 as any);
    }

    try {
      const requestId = randomUUID();
      const prompt = buildTitlePrompt(body.userMessage, body.assistantMessage);
      const ephemeral = ctx.warmPool?.take();
      const runnerId = ephemeral?.warmId ?? session.id;

      const sent = ctx.bridge.sendUtilityQuery(
        runnerId,
        prompt,
        {
          model: "haiku",
          systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT,
          maxTokens: 60,
        },
        requestId,
      );

      if (!sent) {
        if (ephemeral) {
          ctx.tokenPool.release(ephemeral.warmId);
          await ctx.docker.kill(ephemeral.warmId).catch(() => {});
          const fallbackSent = ctx.bridge.sendUtilityQuery(
            session.id,
            prompt,
            {
              model: "haiku",
              systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT,
              maxTokens: 60,
            },
            requestId,
          );
          if (!fallbackSent) {
            return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 500 as any);
          }
        } else {
          return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 500 as any);
        }
      }

      const result = await ctx.bridge.waitForUtilityQueryResult(runnerId, requestId);

      if (ephemeral) {
        ctx.tokenPool.release(ephemeral.warmId);
        ctx.docker.kill(ephemeral.warmId).catch(() => {});
      }

      if (result.error) {
        throw new Error(result.error);
      }

      const title = parseTitle(result.text);
      if (title) {
        ctx.sessions.rename(session.id, title);
        logger.info("orchestrator.api", "title_generated", { session_id: session.id, title });
      }
      return c.json({ title: title || session.name || "" });
    } catch (err) {
      logger.error("orchestrator.api", "title_generation_failed", {
        session_id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ code: "internal", message: "Title generation failed" } satisfies ErrorResponse, 500 as any);
    }
  });

  app.post("/sessions/:id/suggest-folder", async (c) => {
    const session = ctx.sessions.get(c.req.param("id"));
    if (!session) {
      return c.json({ code: "session_not_found", message: "Session not found" } satisfies ErrorResponse, 404 as any);
    }

    let body: { title: string; preview: string; folders: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "invalid_request", message: "Invalid JSON body" } satisfies ErrorResponse, 400 as any);
    }

    if (!body.title?.trim() && !body.preview?.trim()) {
      return c.json({ code: "invalid_request", message: "title or preview is required" } satisfies ErrorResponse, 400 as any);
    }

    try {
      const requestId = randomUUID();
      const prompt = buildFolderPrompt(body.title, body.preview, body.folders);
      const ephemeral = ctx.warmPool?.take();
      const runnerId = ephemeral?.warmId ?? session.id;

      const sent = ctx.bridge.sendUtilityQuery(
        runnerId,
        prompt,
        {
          model: "haiku",
          systemPrompt: FOLDER_SUGGESTION_SYSTEM_PROMPT,
        },
        requestId,
      );

      if (!sent) {
        if (ephemeral) {
          ctx.tokenPool.release(ephemeral.warmId);
          await ctx.docker.kill(ephemeral.warmId).catch(() => {});
          const fallbackSent = ctx.bridge.sendUtilityQuery(
            session.id,
            prompt,
            {
              model: "haiku",
              systemPrompt: FOLDER_SUGGESTION_SYSTEM_PROMPT,
            },
            requestId,
          );
          if (!fallbackSent) {
            return c.json({ code: "internal", message: "No runner available" } satisfies ErrorResponse, 500 as any);
          }
        } else {
          return c.json({ code: "internal", message: "Runner not connected" } satisfies ErrorResponse, 500 as any);
        }
      }

      const result = await ctx.bridge.waitForUtilityQueryResult(runnerId, requestId);

      if (ephemeral) {
        ctx.tokenPool.release(ephemeral.warmId);
        ctx.docker.kill(ephemeral.warmId).catch(() => {});
      }

      if (result.error) {
        throw new Error(result.error);
      }

      const parsed = parseFolderSuggestion(result.text);
      logger.info("orchestrator.api", "folder_suggested", {
        session_id: session.id,
        type: parsed.type,
        folderName: parsed.folderName,
      });

      return c.json(parsed);
    } catch (err) {
      logger.error("orchestrator.api", "folder_suggestion_failed", {
        session_id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ code: "internal", message: "Folder suggestion failed" } satisfies ErrorResponse, 500 as any);
    }
  });
}

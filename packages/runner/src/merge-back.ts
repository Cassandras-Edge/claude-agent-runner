import type { MemIpcClient } from "./mem-ipc.js";
import { logger } from "./logger.js";
import type { DrainResult } from "./background-drainer.js";

/**
 * Merges a background session's result back into the foreground session's
 * mutableMessages via IPC.
 *
 * On success: finds and replaces the synthetic tool_result placeholder
 * (identified by taskId in its content) with the real result.
 *
 * On failure: pushes an error message so the model can course-correct.
 */
export async function mergeBackResult(
  ipc: MemIpcClient,
  backgroundResult: DrainResult,
  taskId: string,
  sessionId: string,
): Promise<void> {
  if (!ipc.isConnected) {
    logger.warn("runner.mergeback", "ipc_not_connected", {
      session_id: sessionId,
      task_id: taskId,
    });
    return;
  }

  if (backgroundResult.success && backgroundResult.result) {
    // Find the synthetic placeholder in mutableMessages
    try {
      const messages = await ipc.getMessages();
      const placeholderIndex = findPlaceholderIndex(messages, taskId);

      if (placeholderIndex >= 0) {
        // Extract the real tool result from the background's result event
        const realContent = extractToolResults(backgroundResult.result);

        // Build replacement message: same structure as the placeholder but with real content
        const placeholder = messages[placeholderIndex];
        const replacement = buildRealResult(placeholder, realContent, taskId);

        await ipc.splice(placeholderIndex, 1, [replacement]);
        logger.info("runner.mergeback", "splice_success", {
          session_id: sessionId,
          task_id: taskId,
          index: placeholderIndex,
        });
      } else {
        // Placeholder not found (maybe conversation was compacted/cleared)
        // Fall back to pushing a notification
        await ipc.push([{
          role: "user",
          content: [{
            type: "text",
            text: `[System] Background task ${taskId} completed successfully.`,
          }],
        }]);
        logger.info("runner.mergeback", "placeholder_not_found_pushed", {
          session_id: sessionId,
          task_id: taskId,
        });
      }
    } catch (err) {
      logger.error("runner.mergeback", "splice_failed", {
        session_id: sessionId,
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    // Background failed — push error into foreground context
    try {
      await ipc.push([{
        role: "user",
        content: [{
          type: "text",
          text: `[System] Background task ${taskId} failed: ${backgroundResult.error || "unknown error"}`,
        }],
      }]);
      logger.info("runner.mergeback", "error_pushed", {
        session_id: sessionId,
        task_id: taskId,
        error: backgroundResult.error,
      });
    } catch (err) {
      logger.error("runner.mergeback", "push_failed", {
        session_id: sessionId,
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Finds the index of the synthetic placeholder message containing the task ID.
 * Searches from the end since the placeholder is likely near the tail.
 */
function findPlaceholderIndex(messages: any[], taskId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = msg?.content || msg?.message?.content;
    if (!content) continue;

    const contentArr = Array.isArray(content) ? content : [content];
    for (const block of contentArr) {
      const text = typeof block === "string" ? block : block?.text || block?.content;
      if (typeof text === "string" && text.includes(taskId)) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Extracts tool result text from a background session's result event.
 * The result event contains the model's final output for that turn.
 */
function extractToolResults(resultEvent: any): string {
  // The result event from SDK has a `result` field with the text output
  if (resultEvent.result && typeof resultEvent.result === "string") {
    return resultEvent.result;
  }
  // Fallback: stringify the event
  return JSON.stringify(resultEvent, null, 2);
}

/**
 * Builds a real tool_result message to replace the synthetic placeholder.
 * Preserves the message structure (role, tool_use_id) but replaces content.
 */
function buildRealResult(placeholder: any, realContent: string, taskId: string): any {
  const content = placeholder?.content || placeholder?.message?.content;
  if (Array.isArray(content)) {
    // Find the tool_result block and replace its content
    const updatedContent = content.map((block: any) => {
      if (block.type === "tool_result" && typeof block.content === "string" && block.content.includes(taskId)) {
        return { ...block, content: realContent };
      }
      return block;
    });
    return { ...placeholder, content: updatedContent, ...(placeholder.message ? { message: { ...placeholder.message, content: updatedContent } } : {}) };
  }
  // Simple string content
  return { ...placeholder, content: realContent };
}

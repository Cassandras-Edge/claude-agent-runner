import WebSocket from "ws";
import { randomUUID } from "crypto";
import type { ContextOperation } from "@bugcat/claude-agent-runner-shared";
import {
  getContextStats,
  injectMessage,
  readSessionChain,
  removeMessage,
  truncateToLastN,
} from "./context.js";
import { getJsonlPath } from "./helpers.js";
import { logger } from "./logger.js";
import { state } from "./state.js";

export async function executeContextOpViaIpc(op: ContextOperation): Promise<any> {
  if (!state.ipc?.isConnected) {
    throw new Error("IPC not connected — cannot execute context operation");
  }

  switch (op.op) {
    case "get_context":
      return await state.ipc.getMessages();
    case "get_stats": {
      const length = await state.ipc.getLength();
      const roles = await state.ipc.getRoles();
      const breakdown: Record<string, number> = {};
      for (const r of roles) {
        breakdown[r] = (breakdown[r] || 0) + 1;
      }
      return {
        message_count: length,
        turn_count: Math.floor(length / 2),
        type_breakdown: breakdown,
        estimated_tokens: length * 500,
      };
    }
    case "remove_message": {
      const messages = await state.ipc.getMessages();
      const idx = messages.findIndex((m: any) => m.uuid === op.uuid);
      if (idx === -1) throw new Error(`Message not found: ${op.uuid}`);
      await state.ipc.splice(idx, 1);
      return undefined;
    }
    case "inject_message": {
      const messages = await state.ipc.getMessages();
      const innerContent = [{ type: "text", text: op.content }];
      const newMsg: any = {
        type: op.role,
        message: {
          role: op.role,
          content: innerContent,
        },
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      };
      if (op.after_uuid === "__start__") {
        await state.ipc.splice(0, 0, [newMsg]);
      } else if (op.after_uuid) {
        const afterIdx = messages.findIndex((m: any) => m.uuid === op.after_uuid);
        if (afterIdx === -1) throw new Error(`Message not found: ${op.after_uuid}`);
        await state.ipc.splice(afterIdx + 1, 0, [newMsg]);
      } else {
        await state.ipc.push([newMsg]);
      }
      return { injected: true };
    }
    case "truncate": {
      const len = await state.ipc.getLength();
      const keepN = op.keep_last_n;
      if (len > keepN) {
        await state.ipc.splice(0, len - keepN);
      }
      return undefined;
    }
  }
}

export function executeContextOpJsonl(op: ContextOperation): any {
  const path = getJsonlPath();
  switch (op.op) {
    case "get_context":
      return readSessionChain(path);
    case "get_stats":
      return getContextStats(path);
    case "remove_message":
      removeMessage(path, op.uuid);
      return undefined;
    case "inject_message":
      return { injected_uuid: injectMessage(path, op.content, op.role, op.after_uuid) };
    case "truncate":
      truncateToLastN(path, op.keep_last_n);
      return undefined;
  }
}

export async function executeContextOp(op: ContextOperation): Promise<any> {
  if (state.ipc?.isConnected) {
    return executeContextOpViaIpc(op);
  }
  return executeContextOpJsonl(op);
}

export async function emitSnapshot(
  ws: WebSocket,
  trigger: "steer" | "compact" | "turn_complete" | "manual",
  requestId?: string,
): Promise<void> {
  if (!state.ipc?.isConnected) return;

  try {
    const messages = await state.ipc.getMessages();
    const length = await state.ipc.getLength();
    const roles = await state.ipc.getRoles();

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "context_snapshot",
        session_id: state.SESSION_ID,
        trigger,
        message_count: length,
        roles,
        messages,
        request_id: requestId,
      }));
    }
    logger.debug("runner.snapshot", "snapshot_emitted", {
      session_id: state.SESSION_ID,
      trigger,
      message_count: length,
    });
  } catch (err) {
    logger.warn("runner.snapshot", "snapshot_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Converts raw Claude Agent SDK events into the wire format
 * sent to the orchestrator over WebSocket.
 *
 * Philosophy: full passthrough. Every SDK event is forwarded.
 * Only `assistant` (flatten BetaMessage) and `stream_event` (unwrap nested event)
 * are transformed; everything else passes through as-is.
 */
export function serializeEvent(event: any): any {
  if (event.type === "assistant") {
    // Flatten BetaMessage content blocks into a clean array
    const blocks = event.message?.content || [];
    return {
      type: "assistant",
      uuid: event.uuid,
      session_id: event.session_id,
      parent_tool_use_id: event.parent_tool_use_id,
      usage: event.message?.usage,
      content: blocks.map((b: any) => {
        if (b.type === "text") return { type: "text", text: b.text };
        if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        if (b.type === "thinking") return { type: "thinking", thinking: b.thinking };
        return b;
      }),
    };
  }

  if (event.type === "stream_event") {
    // Unwrap the nested API stream event
    return {
      type: "stream_event",
      uuid: event.uuid,
      session_id: event.session_id,
      parent_tool_use_id: event.parent_tool_use_id,
      event: event.event,
    };
  }

  // Everything else: pass through as-is
  // Covers: user, result, system (init/status/compact_boundary/hooks/tasks),
  // tool_progress, tool_use_summary, auth_status, and any future event types
  return event;
}

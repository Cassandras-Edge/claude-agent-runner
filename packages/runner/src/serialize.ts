/**
 * Converts raw Claude Agent SDK events into the compact wire format
 * sent to the orchestrator over WebSocket.
 */
export function serializeEvent(event: any): any {
  switch (event.type) {
    case "assistant": {
      const content = event.message?.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("") || "";
      return { type: "assistant", content, uuid: event.uuid };
    }
    case "stream_event": {
      const e = event.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        return { type: "assistant_delta", content: e.delta.text };
      }
      if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta") {
        return { type: "thinking", content: e.delta.thinking };
      }
      return null; // skip other stream events
    }
    case "user": {
      // Tool results
      if (event.tool_use_result) {
        return {
          type: "tool_result",
          tool_use_id: event.tool_use_result.tool_use_id,
          output: event.tool_use_result.output,
          ...(event.uuid ? { uuid: event.uuid } : {}),
        };
      }
      return null;
    }
    case "tool_progress": {
      return {
        type: "tool_progress",
        tool_name: event.tool_name,
        tool_use_id: event.tool_use_id,
        elapsed_time_seconds: event.elapsed_time_seconds,
      };
    }
    case "result": {
      return {
        type: "result",
        subtype: event.subtype,
        result: event.result || "",
        usage: {
          input_tokens: event.usage?.input_tokens || 0,
          output_tokens: event.usage?.output_tokens || 0,
          cost_usd: event.total_cost_usd || 0,
          duration_ms: event.duration_ms || 0,
        },
        ...(event.subtype !== "success" ? { errors: event.errors || [] } : {}),
      };
    }
    default:
      return null;
  }
}

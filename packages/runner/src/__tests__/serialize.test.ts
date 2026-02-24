import { describe, it, expect } from "vitest";
import { serializeEvent } from "../serialize.js";

describe("serializeEvent", () => {
  describe("assistant events", () => {
    it("extracts text content from assistant messages", () => {
      const event = {
        type: "assistant",
        uuid: "abc-123",
        message: {
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      };

      expect(serializeEvent(event)).toEqual({
        type: "assistant",
        content: "Hello world",
        uuid: "abc-123",
      });
    });

    it("filters out non-text content blocks", () => {
      const event = {
        type: "assistant",
        uuid: "abc",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "read", input: {} },
            { type: "text", text: "Result" },
          ],
        },
      };

      expect(serializeEvent(event)).toEqual({
        type: "assistant",
        content: "Result",
        uuid: "abc",
      });
    });

    it("returns empty content when message has no content", () => {
      expect(serializeEvent({ type: "assistant", uuid: "x" })).toEqual({
        type: "assistant",
        content: "",
        uuid: "x",
      });

      expect(serializeEvent({ type: "assistant", uuid: "y", message: {} })).toEqual({
        type: "assistant",
        content: "",
        uuid: "y",
      });
    });
  });

  describe("stream_event events", () => {
    it("extracts text_delta content", () => {
      const event = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "chunk" },
        },
      };

      expect(serializeEvent(event)).toEqual({
        type: "assistant_delta",
        content: "chunk",
      });
    });

    it("extracts thinking_delta content", () => {
      const event = {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "reasoning..." },
        },
      };

      expect(serializeEvent(event)).toEqual({
        type: "thinking",
        content: "reasoning...",
      });
    });

    it("returns null for other stream events", () => {
      expect(serializeEvent({
        type: "stream_event",
        event: { type: "message_start" },
      })).toBeNull();

      expect(serializeEvent({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "input_json_delta" } },
      })).toBeNull();
    });

    it("returns null when event is undefined", () => {
      expect(serializeEvent({ type: "stream_event" })).toBeNull();
    });
  });

  describe("user events (tool results)", () => {
    it("serializes tool_use_result without uuid", () => {
      const event = {
        type: "user",
        tool_use_result: {
          tool_use_id: "tool-1",
          output: "file contents here",
        },
      };

      expect(serializeEvent(event)).toEqual({
        type: "tool_result",
        tool_use_id: "tool-1",
        output: "file contents here",
      });
    });

    it("includes uuid when present on the event", () => {
      const event = {
        type: "user",
        uuid: "event-uuid-123",
        tool_use_result: {
          tool_use_id: "tool-1",
          output: "output",
        },
      };

      expect(serializeEvent(event)).toEqual({
        type: "tool_result",
        tool_use_id: "tool-1",
        output: "output",
        uuid: "event-uuid-123",
      });
    });

    it("returns null for user events without tool results", () => {
      expect(serializeEvent({ type: "user" })).toBeNull();
    });
  });

  describe("tool_progress events", () => {
    it("serializes tool progress", () => {
      const event = {
        type: "tool_progress",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        elapsed_time_seconds: 5.2,
      };

      expect(serializeEvent(event)).toEqual({
        type: "tool_progress",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        elapsed_time_seconds: 5.2,
      });
    });
  });

  describe("result events", () => {
    it("serializes successful results", () => {
      const event = {
        type: "result",
        subtype: "success",
        result: "Task completed",
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.005,
        duration_ms: 3200,
      };

      const serialized = serializeEvent(event);
      expect(serialized).toEqual({
        type: "result",
        subtype: "success",
        result: "Task completed",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cost_usd: 0.005,
          duration_ms: 3200,
        },
      });
      // Success results should NOT have errors key
      expect(serialized).not.toHaveProperty("errors");
    });

    it("serializes error results with errors array", () => {
      const event = {
        type: "result",
        subtype: "error_during_execution",
        result: "",
        errors: ["Something went wrong"],
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.001,
        duration_ms: 100,
      };

      expect(serializeEvent(event)).toEqual({
        type: "result",
        subtype: "error_during_execution",
        result: "",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cost_usd: 0.001,
          duration_ms: 100,
        },
        errors: ["Something went wrong"],
      });
    });

    it("defaults missing usage fields to 0", () => {
      const event = {
        type: "result",
        subtype: "success",
      };

      expect(serializeEvent(event)!.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        duration_ms: 0,
      });
    });

    it("defaults missing result to empty string", () => {
      const event = { type: "result", subtype: "success" };
      expect(serializeEvent(event)!.result).toBe("");
    });
  });

  describe("unknown events", () => {
    it("returns null for unrecognized event types", () => {
      expect(serializeEvent({ type: "unknown_type" })).toBeNull();
      expect(serializeEvent({ type: "system" })).toBeNull();
    });
  });
});

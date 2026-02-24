import { describe, it, expect } from "vitest";
import { serializeEvent } from "../serialize.js";

describe("serializeEvent", () => {
  describe("assistant events", () => {
    it("flattens text content blocks into array", () => {
      const event = {
        type: "assistant",
        uuid: "abc-123",
        session_id: "sess-1",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      };

      expect(serializeEvent(event)).toEqual({
        type: "assistant",
        uuid: "abc-123",
        session_id: "sess-1",
        parent_tool_use_id: null,
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      });
    });

    it("flattens tool_use blocks with id, name, and input", () => {
      const event = {
        type: "assistant",
        uuid: "abc",
        session_id: "s1",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo" } },
            { type: "text", text: "Reading file" },
          ],
        },
      };

      expect(serializeEvent(event)).toEqual({
        type: "assistant",
        uuid: "abc",
        session_id: "s1",
        parent_tool_use_id: null,
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo" } },
          { type: "text", text: "Reading file" },
        ],
      });
    });

    it("flattens thinking blocks", () => {
      const event = {
        type: "assistant",
        uuid: "x",
        session_id: "s1",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "text", text: "Here's my answer" },
          ],
        },
      };

      const result = serializeEvent(event);
      expect(result.content).toEqual([
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "Here's my answer" },
      ]);
    });

    it("returns empty content array when message has no content", () => {
      expect(serializeEvent({ type: "assistant", uuid: "x" }).content).toEqual([]);
      expect(serializeEvent({ type: "assistant", uuid: "y", message: {} }).content).toEqual([]);
    });

    it("passes through unknown block types as-is", () => {
      const event = {
        type: "assistant",
        uuid: "z",
        session_id: "s1",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "unknown_block", data: 42 }],
        },
      };

      expect(serializeEvent(event).content).toEqual([
        { type: "unknown_block", data: 42 },
      ]);
    });
  });

  describe("stream_event events", () => {
    it("unwraps and forwards the inner event", () => {
      const innerEvent = {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "chunk" },
      };
      const event = {
        type: "stream_event",
        uuid: "u1",
        session_id: "s1",
        parent_tool_use_id: null,
        event: innerEvent,
      };

      expect(serializeEvent(event)).toEqual({
        type: "stream_event",
        uuid: "u1",
        session_id: "s1",
        parent_tool_use_id: null,
        event: innerEvent,
      });
    });

    it("forwards tool_use content_block_start events", () => {
      const innerEvent = {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
      };

      const result = serializeEvent({
        type: "stream_event",
        uuid: "u1",
        session_id: "s1",
        parent_tool_use_id: null,
        event: innerEvent,
      });

      expect(result.event).toEqual(innerEvent);
    });

    it("forwards input_json_delta events", () => {
      const innerEvent = {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"com' },
      };

      const result = serializeEvent({
        type: "stream_event",
        uuid: "u1",
        session_id: "s1",
        parent_tool_use_id: null,
        event: innerEvent,
      });

      expect(result.event).toEqual(innerEvent);
    });
  });

  describe("passthrough events", () => {
    it("passes through user events as-is", () => {
      const event = {
        type: "user",
        uuid: "event-uuid-123",
        session_id: "s1",
        tool_use_result: {
          tool_use_id: "tool-1",
          output: "file contents here",
        },
      };

      expect(serializeEvent(event)).toEqual(event);
    });

    it("passes through tool_progress events as-is", () => {
      const event = {
        type: "tool_progress",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        elapsed_time_seconds: 5.2,
        uuid: "u1",
        session_id: "s1",
      };

      expect(serializeEvent(event)).toEqual(event);
    });

    it("passes through result events as-is", () => {
      const event = {
        type: "result",
        subtype: "success",
        result: "Task completed",
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.005,
        duration_ms: 3200,
        uuid: "u1",
        session_id: "s1",
      };

      expect(serializeEvent(event)).toEqual(event);
    });

    it("passes through system events as-is", () => {
      const event = {
        type: "system",
        subtype: "init",
        model: "haiku",
        tools: ["Bash", "Read"],
        uuid: "u1",
        session_id: "s1",
      };

      expect(serializeEvent(event)).toEqual(event);
    });

    it("passes through tool_use_summary events as-is", () => {
      const event = {
        type: "tool_use_summary",
        summary: "Read file /foo.ts",
        preceding_tool_use_ids: ["t1"],
        uuid: "u1",
        session_id: "s1",
      };

      expect(serializeEvent(event)).toEqual(event);
    });

    it("passes through unknown event types as-is", () => {
      const event = { type: "some_future_type", data: 42 };
      expect(serializeEvent(event)).toEqual(event);
    });
  });
});

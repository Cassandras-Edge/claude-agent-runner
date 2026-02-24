import { describe, it, expect } from "vitest";
import { createStderrRingBuffer, buildZeroEventError } from "../helpers.js";

describe("createStderrRingBuffer", () => {
  it("stores lines from pushed chunks", () => {
    const buf = createStderrRingBuffer(10);
    buf.push("line one\nline two\n");

    expect(buf.tail()).toEqual(["line one", "line two"]);
  });

  it("handles chunks without trailing newlines", () => {
    const buf = createStderrRingBuffer(10);
    buf.push("partial");

    expect(buf.tail()).toEqual(["partial"]);
  });

  it("handles Windows-style line endings", () => {
    const buf = createStderrRingBuffer(10);
    buf.push("line one\r\nline two\r\n");

    expect(buf.tail()).toEqual(["line one", "line two"]);
  });

  it("caps at maxLines by evicting oldest", () => {
    const buf = createStderrRingBuffer(3);
    buf.push("a\nb\nc\nd\ne\n");

    expect(buf.tail()).toEqual(["c", "d", "e"]);
  });

  it("skips empty lines from splitting", () => {
    const buf = createStderrRingBuffer(10);
    buf.push("\n\nfoo\n\n");

    expect(buf.tail()).toEqual(["foo"]);
  });

  it("handles multiple push calls", () => {
    const buf = createStderrRingBuffer(5);
    buf.push("a\nb\n");
    buf.push("c\nd\n");

    expect(buf.tail()).toEqual(["a", "b", "c", "d"]);
  });

  it("tail(limit) returns at most limit lines", () => {
    const buf = createStderrRingBuffer(10);
    buf.push("a\nb\nc\nd\ne\n");

    expect(buf.tail(2)).toEqual(["d", "e"]);
  });

  it("tail(limit) clamps to at least 1 line", () => {
    const buf = createStderrRingBuffer(10);
    buf.push("a\nb\n");

    expect(buf.tail(0)).toEqual(["b"]);
  });

  it("tail(limit) clamps to maxLines", () => {
    const buf = createStderrRingBuffer(3);
    buf.push("a\nb\nc\n");

    expect(buf.tail(100)).toEqual(["a", "b", "c"]);
  });

  it("returns empty result for an empty buffer", () => {
    const buf = createStderrRingBuffer(10);
    // tail on empty should return at least a slice (which will be empty)
    expect(buf.tail()).toEqual([]);
  });
});

describe("buildZeroEventError", () => {
  it("returns a JSON string with the correct structure", () => {
    const result = buildZeroEventError(
      "Timed out waiting for first SDK event",
      "sonnet",
      10,
      "/workspace",
      ["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"],
      ["stderr line 1", "stderr line 2"],
    );

    const parsed = JSON.parse(result);

    expect(parsed.code).toBe("claude_cli_no_events");
    expect(parsed.reason).toBe("Timed out waiting for first SDK event");
    expect(parsed.model).toBe("sonnet");
    expect(parsed.maxTurns).toBe(10);
    expect(parsed.cwd).toBe("/workspace");
    expect(parsed.childEnvKeys).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"]);
    expect(parsed.stderrTail).toEqual(["stderr line 1", "stderr line 2"]);
  });

  it("handles undefined maxTurns", () => {
    const result = buildZeroEventError("reason", "haiku", undefined, "/workspace", [], []);
    const parsed = JSON.parse(result);

    // JSON.stringify converts undefined to the key being omitted
    expect(parsed.maxTurns).toBeUndefined();
  });

  it("handles empty arrays", () => {
    const result = buildZeroEventError("reason", "opus", 5, "/workspace", [], []);
    const parsed = JSON.parse(result);

    expect(parsed.childEnvKeys).toEqual([]);
    expect(parsed.stderrTail).toEqual([]);
  });

  it("outputs pretty-printed JSON", () => {
    const result = buildZeroEventError("reason", "sonnet", 1, "/workspace", ["KEY"], ["line"]);
    // Should be indented (multi-line)
    expect(result).toContain("\n");
    expect(result).toContain("  ");
  });
});

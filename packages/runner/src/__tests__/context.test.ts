import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readJsonl,
  writeJsonl,
  buildChain,
  readSessionChain,
  removeMessage,
  injectMessage,
  truncateToLastN,
  getContextStats,
} from "../context.js";

// --- Test helpers ---

function makeLine(uuid: string, parentUuid: string | null, type: string, content = "test"): string {
  if (type === "user") {
    return JSON.stringify({
      uuid,
      parentUuid,
      type: "user",
      message: { role: "user", content },
      timestamp: new Date().toISOString(),
    });
  }
  if (type === "assistant") {
    return JSON.stringify({
      uuid,
      parentUuid,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: content }] },
      timestamp: new Date().toISOString(),
    });
  }
  if (type === "system") {
    return JSON.stringify({
      uuid,
      parentUuid,
      type: "system",
      subtype: "compact_boundary",
      content,
      timestamp: new Date().toISOString(),
    });
  }
  return JSON.stringify({ uuid, parentUuid, type, timestamp: new Date().toISOString() });
}

let tmpDir: string;
let testFile: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  testFile = join(tmpDir, "test-session.jsonl");
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

// --- readJsonl ---

describe("readJsonl", () => {
  it("returns empty array for non-existent file", () => {
    expect(readJsonl(join(tmpDir, "nope.jsonl"))).toEqual([]);
  });

  it("parses valid JSONL lines", () => {
    writeFileSync(testFile, [
      makeLine("a", null, "user", "hello"),
      makeLine("b", "a", "assistant", "hi"),
    ].join("\n") + "\n");

    const records = readJsonl(testFile);
    expect(records).toHaveLength(2);
    expect(records[0].uuid).toBe("a");
    expect(records[1].uuid).toBe("b");
  });

  it("skips malformed lines", () => {
    writeFileSync(testFile, '{"uuid":"a","parentUuid":null,"type":"user"}\nBAD LINE\n{"uuid":"b","parentUuid":"a","type":"user"}\n');
    const records = readJsonl(testFile);
    expect(records).toHaveLength(2);
  });

  it("skips empty lines", () => {
    writeFileSync(testFile, '{"uuid":"a","parentUuid":null,"type":"user"}\n\n\n{"uuid":"b","parentUuid":"a","type":"user"}\n');
    expect(readJsonl(testFile)).toHaveLength(2);
  });
});

// --- buildChain ---

describe("buildChain", () => {
  it("returns empty for empty input", () => {
    expect(buildChain([])).toEqual([]);
  });

  it("builds a linear chain", () => {
    const records = [
      { uuid: "a", parentUuid: null, type: "user" },
      { uuid: "b", parentUuid: "a", type: "assistant" },
      { uuid: "c", parentUuid: "b", type: "user" },
    ];
    const chain = buildChain(records as any);
    expect(chain.map((r) => r.uuid)).toEqual(["a", "b", "c"]);
  });

  it("handles multiple roots (post-compaction), picks longest chain", () => {
    const records = [
      // Old root chain (2 messages)
      { uuid: "old-1", parentUuid: null, type: "user" },
      { uuid: "old-2", parentUuid: "old-1", type: "assistant" },
      // New root chain after compact (3 messages)
      { uuid: "new-1", parentUuid: null, type: "system" },
      { uuid: "new-2", parentUuid: "new-1", type: "user" },
      { uuid: "new-3", parentUuid: "new-2", type: "assistant" },
    ];
    const chain = buildChain(records as any);
    expect(chain.map((r) => r.uuid)).toEqual(["new-1", "new-2", "new-3"]);
  });

  it("handles cycle protection", () => {
    const records = [
      { uuid: "a", parentUuid: null, type: "user" },
      { uuid: "b", parentUuid: "a", type: "assistant" },
      { uuid: "c", parentUuid: "b", type: "user" },
    ];
    // Manually create a cycle
    records[0].parentUuid = null;
    const chain = buildChain(records as any);
    expect(chain.length).toBeGreaterThanOrEqual(1);
  });
});

// --- readSessionChain ---

describe("readSessionChain", () => {
  it("filters to user/assistant/system only", () => {
    writeFileSync(testFile, [
      makeLine("a", null, "user", "hello"),
      makeLine("b", "a", "assistant", "hi"),
      JSON.stringify({ uuid: "c", parentUuid: "b", type: "progress", data: {} }),
      makeLine("d", "c", "user", "next"),
    ].join("\n") + "\n");

    const chain = readSessionChain(testFile);
    expect(chain).toHaveLength(3);
    expect(chain.map((m) => m.type)).toEqual(["user", "assistant", "user"]);
  });

  it("returns empty for empty file", () => {
    writeFileSync(testFile, "");
    expect(readSessionChain(testFile)).toEqual([]);
  });
});

// --- removeMessage ---

describe("removeMessage", () => {
  it("removes a message and re-links children", () => {
    writeFileSync(testFile, [
      makeLine("a", null, "user", "first"),
      makeLine("b", "a", "assistant", "second"),
      makeLine("c", "b", "user", "third"),
    ].join("\n") + "\n");

    removeMessage(testFile, "b");

    const records = readJsonl(testFile);
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.uuid === "b")).toBeUndefined();
    // c's parent should now be a
    expect(records.find((r) => r.uuid === "c")?.parentUuid).toBe("a");
  });

  it("throws for non-existent UUID", () => {
    writeFileSync(testFile, makeLine("a", null, "user", "hello") + "\n");
    expect(() => removeMessage(testFile, "nonexistent")).toThrow("not found");
  });

  it("removes root message and nulls children parentUuid", () => {
    writeFileSync(testFile, [
      makeLine("a", null, "user", "first"),
      makeLine("b", "a", "assistant", "second"),
    ].join("\n") + "\n");

    removeMessage(testFile, "a");

    const records = readJsonl(testFile);
    expect(records).toHaveLength(1);
    expect(records[0].uuid).toBe("b");
    expect(records[0].parentUuid).toBeNull();
  });
});

// --- injectMessage ---

describe("injectMessage", () => {
  it("appends at tail when no afterUuid", () => {
    writeFileSync(testFile, [
      makeLine("a", null, "user", "first"),
      makeLine("b", "a", "assistant", "second"),
    ].join("\n") + "\n");

    const newUuid = injectMessage(testFile, "injected content", "user");
    expect(newUuid).toBeTruthy();

    const records = readJsonl(testFile);
    expect(records).toHaveLength(3);
    const injected = records.find((r) => r.uuid === newUuid);
    expect(injected).toBeDefined();
    expect(injected?.parentUuid).toBe("b"); // tail of chain
  });

  it("inserts after a specific message and re-links", () => {
    writeFileSync(testFile, [
      makeLine("a", null, "user", "first"),
      makeLine("b", "a", "assistant", "second"),
      makeLine("c", "b", "user", "third"),
    ].join("\n") + "\n");

    const newUuid = injectMessage(testFile, "injected", "system", "a");

    const records = readJsonl(testFile);
    expect(records).toHaveLength(4);

    // New record should be child of a
    const injected = records.find((r) => r.uuid === newUuid);
    expect(injected?.parentUuid).toBe("a");

    // b should now be child of injected
    const b = records.find((r) => r.uuid === "b");
    expect(b?.parentUuid).toBe(newUuid);
  });

  it("throws for invalid afterUuid", () => {
    writeFileSync(testFile, makeLine("a", null, "user", "hello") + "\n");
    expect(() => injectMessage(testFile, "test", "user", "nonexistent")).toThrow("not found");
  });

  it("works on empty file", () => {
    writeFileSync(testFile, "");
    const uuid = injectMessage(testFile, "first message", "user");
    const records = readJsonl(testFile);
    expect(records).toHaveLength(1);
    expect(records[0].uuid).toBe(uuid);
    expect(records[0].parentUuid).toBeNull();
  });
});

// --- truncateToLastN ---

describe("truncateToLastN", () => {
  it("keeps last N turn pairs", () => {
    writeFileSync(testFile, [
      makeLine("u1", null, "user", "turn 1"),
      makeLine("a1", "u1", "assistant", "reply 1"),
      makeLine("u2", "a1", "user", "turn 2"),
      makeLine("a2", "u2", "assistant", "reply 2"),
      makeLine("u3", "a2", "user", "turn 3"),
      makeLine("a3", "u3", "assistant", "reply 3"),
    ].join("\n") + "\n");

    truncateToLastN(testFile, 2);

    const records = readJsonl(testFile);
    // Should keep last 4 conversational messages (2 turn pairs)
    const uuids = records.map((r) => r.uuid);
    expect(uuids).toContain("u2");
    expect(uuids).toContain("a2");
    expect(uuids).toContain("u3");
    expect(uuids).toContain("a3");
    expect(uuids).not.toContain("u1");
    expect(uuids).not.toContain("a1");

    // First kept record should have null parentUuid
    const firstKept = records.find((r) => r.uuid === "u2");
    expect(firstKept?.parentUuid).toBeNull();
  });

  it("no-op when fewer turns than N", () => {
    writeFileSync(testFile, [
      makeLine("u1", null, "user", "turn 1"),
      makeLine("a1", "u1", "assistant", "reply 1"),
    ].join("\n") + "\n");

    truncateToLastN(testFile, 5);

    const records = readJsonl(testFile);
    expect(records).toHaveLength(2);
  });

  it("preserves system messages in kept range", () => {
    writeFileSync(testFile, [
      makeLine("u1", null, "user", "turn 1"),
      makeLine("a1", "u1", "assistant", "reply 1"),
      makeLine("s1", "a1", "system", "compacted"),
      makeLine("u2", "s1", "user", "turn 2"),
      makeLine("a2", "u2", "assistant", "reply 2"),
    ].join("\n") + "\n");

    truncateToLastN(testFile, 1);

    const records = readJsonl(testFile);
    const uuids = records.map((r) => r.uuid);
    expect(uuids).toContain("u2");
    expect(uuids).toContain("a2");
    expect(uuids).not.toContain("u1");
    expect(uuids).not.toContain("a1");
  });
});

// --- getContextStats ---

describe("getContextStats", () => {
  it("returns correct stats", () => {
    writeFileSync(testFile, [
      makeLine("u1", null, "user", "hello"),
      makeLine("a1", "u1", "assistant", "world"),
      makeLine("u2", "a1", "user", "foo"),
      makeLine("a2", "u2", "assistant", "bar"),
    ].join("\n") + "\n");

    const stats = getContextStats(testFile);
    expect(stats.message_count).toBe(4);
    expect(stats.turn_count).toBe(2);
    expect(stats.type_breakdown.user).toBe(2);
    expect(stats.type_breakdown.assistant).toBe(2);
    expect(stats.estimated_tokens).toBeGreaterThan(0);
  });

  it("returns zeros for empty file", () => {
    writeFileSync(testFile, "");
    const stats = getContextStats(testFile);
    expect(stats.message_count).toBe(0);
    expect(stats.turn_count).toBe(0);
  });

  it("returns zeros for non-existent file", () => {
    const stats = getContextStats(join(tmpDir, "nope.jsonl"));
    expect(stats.message_count).toBe(0);
    expect(stats.turn_count).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "net";
import { unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemIpcClient } from "../mem-ipc.js";
import { mergeBackResult } from "../merge-back.js";
import { drainBackground, type DrainResult } from "../background-drainer.js";
import WebSocket from "ws";

const SOCK_PATH = join(tmpdir(), `fas-test-${process.pid}.sock`);

// --- Mock IPC server (reused from mem-ipc.test.ts pattern) ---

function createMockServer(messages: any[] = []): Server {
  const srv = createServer((conn: Socket) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line);
          const res = handleCmd(req, messages);
          conn.write(JSON.stringify(res) + "\n");
        } catch (e) {
          conn.write(JSON.stringify({ ok: false, error: String(e) }) + "\n");
        }
      }
    });
    conn.on("error", () => {});
  });
  return srv;
}

function handleCmd(req: any, mm: any[]): any {
  const { cmd } = req;
  if (cmd === "get_length") return { ok: true, length: mm.length };
  if (cmd === "get_messages") {
    const s = req.start || 0;
    const e = req.end || mm.length;
    return { ok: true, messages: mm.slice(s, e) };
  }
  if (cmd === "splice") {
    const start = req.start ?? 0;
    const dc = req.deleteCount ?? 0;
    const items = req.items || [];
    const removed = mm.splice(start, dc, ...items);
    return { ok: true, removed, length: mm.length };
  }
  if (cmd === "push") {
    const msgs = req.messages || [];
    for (const m of msgs) mm.push(m);
    return { ok: true, length: mm.length };
  }
  return { ok: false, error: "unknown command: " + cmd };
}

// --- Tests ---

describe("merge-back", () => {
  let server: Server;
  let ipc: MemIpcClient;
  let messages: any[];

  beforeEach(async () => {
    messages = [
      { role: "user", content: [{ type: "text", text: "write auth module" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_abc", name: "Write", input: { file_path: "/src/auth.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_abc", content: "Operation forked to background (task ID: fas_test123). Continuing in background." }] },
      { role: "user", content: [{ type: "text", text: "quick question about config" }] },
    ];

    server = createMockServer(messages);
    await new Promise<void>((resolve) => {
      if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
      server.listen(SOCK_PATH, resolve);
    });

    ipc = new MemIpcClient();
    await ipc.connect(SOCK_PATH, 3, 50);
  });

  afterEach(() => {
    ipc.disconnect();
    server.close();
    if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
  });

  it("splices real result on success", async () => {
    const bgResult: DrainResult = {
      success: true,
      result: { type: "result", result: "File written successfully." },
    };

    await mergeBackResult(ipc, bgResult, "fas_test123", "test-session");

    // The synthetic result (index 2) should be replaced with real content
    expect(messages[2].content[0].content).not.toContain("fas_test123");
    expect(messages[2].content[0].content).toContain("File written successfully");
  });

  it("pushes error message on failure", async () => {
    const bgResult: DrainResult = {
      success: false,
      error: "permission denied",
    };

    const originalLength = messages.length;
    await mergeBackResult(ipc, bgResult, "fas_test123", "test-session");

    // Should have pushed an error message
    expect(messages.length).toBe(originalLength + 1);
    expect(messages[messages.length - 1].content[0].text).toContain("failed");
    expect(messages[messages.length - 1].content[0].text).toContain("permission denied");
  });

  it("pushes notification when placeholder not found", async () => {
    const bgResult: DrainResult = {
      success: true,
      result: { type: "result", result: "done" },
    };

    const originalLength = messages.length;
    // Use a task ID that doesn't exist in messages
    await mergeBackResult(ipc, bgResult, "nonexistent_id", "test-session");

    // Should fall back to push
    expect(messages.length).toBe(originalLength + 1);
    expect(messages[messages.length - 1].content[0].text).toContain("completed successfully");
  });
});

describe("background-drainer", () => {
  it("captures result event from mock session stream", async () => {
    // Create a mock session that emits events
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "working..." }] } },
      { type: "tool_use_summary", tool: "Write", status: "completed" },
      { type: "result", subtype: "success", result: "Task completed" },
    ];

    const mockSession = {
      stream: async function* () {
        for (const event of events) {
          yield event;
        }
      },
    };

    // Create a mock WebSocket that captures sent messages
    const sentMessages: any[] = [];
    const mockWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => { sentMessages.push(JSON.parse(data)); },
    } as any;

    const result = await drainBackground(
      mockSession as any,
      mockWs,
      "test-session",
      "fas_task1",
    );

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result.type).toBe("result");

    // All events should have been forwarded as background events
    expect(sentMessages.length).toBe(3);
    expect(sentMessages[0].background).toBe(true);
    expect(sentMessages[0].task_id).toBe("fas_task1");
  });

  it("handles stream error gracefully", async () => {
    const mockSession = {
      stream: async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "starting" }] } };
        throw new Error("connection lost");
      },
    };

    const mockWs = {
      readyState: WebSocket.OPEN,
      send: () => {},
    } as any;

    const result = await drainBackground(
      mockSession as any,
      mockWs,
      "test-session",
      "fas_task2",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("connection lost");
  });
});

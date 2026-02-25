import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "net";
import { unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemIpcClient } from "../mem-ipc.js";

const SOCK_PATH = join(tmpdir(), `mem-ipc-test-${process.pid}.sock`);

/** Minimal mock IPC server mimicking the memory-ipc patch. */
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
  if (cmd === "get_roles") {
    return { ok: true, roles: mm.map((m) => m.role || "unknown") };
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
    mm.push(...msgs);
    return { ok: true, length: mm.length };
  }
  if (cmd === "pop") {
    const count = req.count || 1;
    const removed: any[] = [];
    for (let i = 0; i < count && mm.length > 0; i++) removed.push(mm.pop());
    return { ok: true, removed };
  }
  if (cmd === "clear") {
    mm.length = 0;
    return { ok: true, length: 0 };
  }
  if (cmd === "set") {
    mm.length = 0;
    if (req.messages) mm.push(...req.messages);
    return { ok: true, length: mm.length };
  }
  if (cmd === "session_id") return { ok: true, id: "test-session-123" };
  return { ok: false, error: "unknown command: " + cmd };
}

describe("MemIpcClient", () => {
  let server: Server;
  let client: MemIpcClient;
  let messages: any[];

  beforeEach(async () => {
    if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
    messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ];
    server = createMockServer(messages);
    await new Promise<void>((resolve) => server.listen(SOCK_PATH, resolve));
    client = new MemIpcClient();
    await client.connect(SOCK_PATH, 3, 50);
  });

  afterEach(() => {
    client.disconnect();
    server.close();
    if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
  });

  it("connects and reports isConnected", () => {
    expect(client.isConnected).toBe(true);
  });

  it("getLength returns message count", async () => {
    const len = await client.getLength();
    expect(len).toBe(2);
  });

  it("getMessages returns all messages", async () => {
    const msgs = await client.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("getMessages with range", async () => {
    const msgs = await client.getMessages(0, 1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("getRoles returns role strings", async () => {
    const roles = await client.getRoles();
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("push adds messages", async () => {
    const newLen = await client.push([
      { role: "user", content: [{ type: "text", text: "More" }] },
    ]);
    expect(newLen).toBe(3);
    expect(await client.getLength()).toBe(3);
  });

  it("pop removes last message", async () => {
    const removed = await client.pop();
    expect(removed).toHaveLength(1);
    expect(removed[0].role).toBe("assistant");
    expect(await client.getLength()).toBe(1);
  });

  it("splice removes and inserts", async () => {
    const result = await client.splice(1, 1, [
      { role: "assistant", content: [{ type: "text", text: "Replaced" }] },
    ]);
    expect(result.removed).toHaveLength(1);
    expect(result.length).toBe(2);
    const msgs = await client.getMessages();
    expect(msgs[1].content[0].text).toBe("Replaced");
  });

  it("clear empties messages", async () => {
    await client.clear();
    expect(await client.getLength()).toBe(0);
  });

  it("set replaces all messages", async () => {
    const newLen = await client.set([
      { role: "system", content: [{ type: "text", text: "New context" }] },
    ]);
    expect(newLen).toBe(1);
    const msgs = await client.getMessages();
    expect(msgs[0].role).toBe("system");
  });

  it("sessionId returns session id", async () => {
    const id = await client.sessionId();
    expect(id).toBe("test-session-123");
  });

  it("disconnect rejects pending requests", async () => {
    // Start a request then immediately disconnect
    const p = client.getLength();
    client.disconnect();
    await expect(p).rejects.toThrow();
  });

  it("connect retries until socket available", async () => {
    const lateSock = join(tmpdir(), `mem-ipc-late-${process.pid}.sock`);
    const lateClient = new MemIpcClient();

    // Start server after a delay
    const lateSrv = createMockServer([]);
    setTimeout(() => {
      lateSrv.listen(lateSock);
    }, 150);

    await lateClient.connect(lateSock, 10, 50);
    expect(lateClient.isConnected).toBe(true);

    lateClient.disconnect();
    lateSrv.close();
    if (existsSync(lateSock)) unlinkSync(lateSock);
  });

  it("connect fails after max retries", async () => {
    const badSock = join(tmpdir(), `mem-ipc-bad-${process.pid}.sock`);
    const badClient = new MemIpcClient();
    await expect(badClient.connect(badSock, 2, 10)).rejects.toThrow(
      /Failed to connect/
    );
  });

  it("handles rapid sequential commands", async () => {
    const len1 = await client.getLength();
    await client.push([{ role: "user", content: "a" }]);
    const len2 = await client.getLength();
    await client.pop();
    const len3 = await client.getLength();
    expect(len1).toBe(2);
    expect(len2).toBe(3);
    expect(len3).toBe(2);
  });
});

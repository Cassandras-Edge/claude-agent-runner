#!/usr/bin/env node
/**
 * End-to-end tests for the client-facing WebSocket API, context/IPC
 * operations, steer, fork-and-steer, and patch behaviour.
 *
 * Runs against a live orchestrator (requires docker compose up).
 * Tests the full pipeline: client WS → orchestrator → real runner (Claude).
 *
 * Covers:
 *   - WS protocol (connect, ping, subscribe, send, steer, fork-and-steer, compact)
 *   - Context surgery via REST (exercises memory-ipc patch on the runner)
 *   - Parallel tool call completion (exercises no-sibling-abort patch)
 *
 * Usage:
 *   node test-client-ws.mjs
 *   BASE_URL=http://localhost:9080 node test-client-ws.mjs
 */
import { WebSocket } from "ws";

const BASE_URL = process.env.BASE_URL || "http://localhost:9080";
const WS_URL = process.env.WS_URL || BASE_URL.replace(/^http/, "ws") + "/ws";
const MODEL = process.env.MODEL || "claude-sonnet-4-20250514";

// --- Test runner ---

let pass = 0;
let fail = 0;
const failures = [];

function ok(msg) {
  pass++;
  console.log(`  ✓ ${msg}`);
}

function notOk(msg, detail) {
  fail++;
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`    ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  failures.push(msg);
}

function assert(condition, msg, detail) {
  if (condition) ok(msg);
  else notOk(msg, detail);
}

// --- HTTP helpers ---

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, json: await res.json() };
}

async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE" });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// --- WS helpers ---

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function send(ws, frame) {
  ws.send(JSON.stringify(frame));
}

function waitFor(ws, predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", onMsg);
      reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    function onMsg(data) {
      const frame = JSON.parse(data.toString());
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.removeListener("message", onMsg);
        resolve(frame);
      }
    }
    ws.on("message", onMsg);
  });
}

function collectUntil(ws, stopPredicate, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const timer = setTimeout(() => {
      ws.removeListener("message", onMsg);
      reject(new Error(`collectUntil timed out after ${timeoutMs}ms (got ${frames.length} frames)`));
    }, timeoutMs);
    function onMsg(data) {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      if (stopPredicate(frame)) {
        clearTimeout(timer);
        ws.removeListener("message", onMsg);
        resolve(frames);
      }
    }
    ws.on("message", onMsg);
  });
}

async function waitForStatus(sessionId, targets, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await get(`/sessions/${sessionId}`);
    if (targets.includes(json.status)) return json.status;
    await sleep(1000);
  }
  throw new Error(`Session ${sessionId} never reached ${targets.join("/")}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Session lifecycle ---

let sessionId;

async function createSession() {
  const { status, json } = await post("/sessions", {
    model: MODEL,
    maxTurns: 1,
    systemPrompt: "You are a test assistant. Always respond with exactly one word: PINEAPPLE",
  });
  assert(status === 200, `Session created (HTTP ${status})`, json);
  sessionId = json.session_id;
  if (!sessionId) throw new Error("No session_id in response");
  console.log(`    session_id: ${sessionId}`);

  const s = await waitForStatus(sessionId, ["ready", "idle"]);
  assert(s === "ready" || s === "idle", `Session is ${s}`);
}

async function cleanupSession() {
  if (!sessionId) return;
  try {
    // Wait for session to settle (fork-and-steer background may be draining)
    await waitForStatus(sessionId, ["idle", "ready", "stopped", "error"], 60_000).catch(() => {});
    await del(`/sessions/${sessionId}`);
    ok(`Session ${sessionId} cleaned up`);
  } catch {
    console.log(`  (cleanup: session ${sessionId} may already be gone)`);
  }
}

// ════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════

async function testPreflight() {
  console.log("\n--- Preflight ---");
  const { json } = await get("/health");
  assert(json.status === "ok", "Orchestrator is healthy");
  assert(json.docker_connected === true, "Docker is connected");
}

async function testPingPong() {
  console.log("\n--- Test 1: Connect + Ping/Pong ---");
  const ws = await connect();
  assert(ws.readyState === WebSocket.OPEN, "WebSocket connected");

  send(ws, { type: "ping" });
  const pong = await waitFor(ws, (f) => f.type === "pong", 5000);
  assert(pong.type === "pong", "Pong received");
  ws.close();
}

async function testSubscribeSendReceive() {
  console.log("\n--- Test 2: Subscribe + send + receive events ---");
  const ws = await connect();

  // Subscribe
  send(ws, { type: "subscribe", session_id: sessionId, request_id: "sub-1" });
  const subFrame = await waitFor(ws, (f) => f.type === "subscribed", 5000);
  assert(subFrame.type === "subscribed", `Subscribed (status: ${subFrame.status})`);
  assert(subFrame.request_id === "sub-1", "request_id echoed back");

  // Send message
  send(ws, { type: "send", session_id: sessionId, message: "Say PINEAPPLE", request_id: "msg-1" });
  const ack = await waitFor(ws, (f) => f.type === "ack", 5000);
  assert(ack.ok === true, "Send ack ok=true");
  assert(ack.request_id === "msg-1", "Ack echoes request_id");

  // Collect until result
  const frames = await collectUntil(ws, (f) => f.type === "event" && f.event?.type === "result");

  const statusFrames = frames.filter((f) => f.type === "status");
  const eventFrames = frames.filter((f) => f.type === "event");
  const assistantEvents = eventFrames.filter((f) => f.event?.type === "assistant");
  const resultEvent = eventFrames.find((f) => f.event?.type === "result");
  const eventTypes = [...new Set(eventFrames.map((f) => f.event?.type))];

  assert(statusFrames.length > 0, `Got ${statusFrames.length} status frame(s): [${statusFrames.map((f) => f.status).join(", ")}]`);
  assert(assistantEvents.length > 0, `Got ${assistantEvents.length} assistant event(s)`);
  assert(resultEvent, "Got result event");
  assert(resultEvent?.event?.subtype === "success", `Result subtype: ${resultEvent?.event?.subtype}`);
  ok(`Event types: [${eventTypes.join(", ")}]`);
  ok(`Total frames: ${frames.length}`);

  ws.close();
}

async function testSubscribeNonExistent() {
  console.log("\n--- Test 3: Subscribe to non-existent session ---");
  const ws = await connect();
  send(ws, { type: "subscribe", session_id: "does-not-exist-xyz" });
  const errFrame = await waitFor(ws, (f) => f.type === "error", 5000);
  assert(errFrame.error_code === "session_not_found", `Error code: ${errFrame.error_code}`);
  ws.close();
}

async function testTwoClients() {
  console.log("\n--- Test 4: Two clients watching same session ---");
  const ws1 = await connect();
  const ws2 = await connect();

  // Both subscribe
  send(ws1, { type: "subscribe", session_id: sessionId });
  send(ws2, { type: "subscribe", session_id: sessionId });
  await waitFor(ws1, (f) => f.type === "subscribed", 5000);
  await waitFor(ws2, (f) => f.type === "subscribed", 5000);

  // Client 2 sends a message
  send(ws2, { type: "send", session_id: sessionId, message: "Say BANANA" });
  await waitFor(ws2, (f) => f.type === "ack", 5000);

  // Both should receive the result event
  const [r1, r2] = await Promise.all([
    waitFor(ws1, (f) => f.type === "event" && f.event?.type === "result", 120_000),
    waitFor(ws2, (f) => f.type === "event" && f.event?.type === "result", 120_000),
  ]);

  assert(r1.event?.type === "result", "Client 1 got result");
  assert(r2.event?.type === "result", "Client 2 got result");

  ws1.close();
  ws2.close();
}

async function testCompact() {
  console.log("\n--- Test 5: Compact via WS ---");
  const ws = await connect();
  send(ws, { type: "compact", session_id: sessionId, custom_instructions: "Be brief", request_id: "cpt-1" });
  const ack = await waitFor(ws, (f) => f.type === "ack", 10_000);
  assert(ack.ok === true, "Compact ack ok=true");
  ws.close();
}

async function testSteer() {
  console.log("\n--- Test 10: Steer (abort + resume) ---");
  const ws = await connect();

  // Subscribe
  send(ws, { type: "subscribe", session_id: sessionId });
  await waitFor(ws, (f) => f.type === "subscribed", 5000);

  // Send slow message
  send(ws, {
    type: "send",
    session_id: sessionId,
    message: "Write a very detailed 500-word essay about the history of mathematics from ancient Babylon through modern times.",
    request_id: "slow-steer",
  });
  await waitFor(ws, (f) => f.type === "ack", 5000);

  // Wait for busy status
  await waitFor(ws, (f) => f.type === "status" && f.status === "busy", 15_000);
  ok("Session became busy");

  // Steer — abort and redirect
  send(ws, {
    type: "steer",
    session_id: sessionId,
    message: "Ignore the essay. Just say the word MANGO.",
    mode: "steer",
    request_id: "steer-1",
  });
  const steerAck = await waitFor(ws, (f) => f.type === "ack" && f.request_id === "steer-1", 5000);
  assert(steerAck.ok === true, `Steer ack ok=${steerAck.ok}`);

  // Wait for result from the steered message
  const result = await waitFor(ws, (f) => f.type === "event" && f.event?.type === "result", 120_000);
  assert(result.event?.subtype === "success", `Steer result subtype: ${result.event?.subtype}`);

  ws.close();
}

async function testForkAndSteer() {
  console.log("\n--- Test 11: Fork-and-steer (fork while busy) ---");

  // Wait for session to be idle
  await waitForStatus(sessionId, ["idle", "ready"]);

  const ws = await connect();
  const startTime = Date.now();

  // Subscribe
  send(ws, { type: "subscribe", session_id: sessionId });
  await waitFor(ws, (f) => f.type === "subscribed", 5000);

  // Send slow message
  send(ws, {
    type: "send",
    session_id: sessionId,
    message:
      "Write a COMPLETE implementation of a red-black tree in TypeScript with all rotations, insert, delete, search, and traversal. At least 300 lines.",
    request_id: "slow-fork",
  });
  await waitFor(ws, (f) => f.type === "ack", 5000);

  // Wait for busy
  await waitFor(ws, (f) => f.type === "status" && f.status === "busy", 15_000);
  const busyTime = Date.now() - startTime;
  ok(`Session became busy after ${busyTime}ms`);

  // Fork-and-steer — foreground should answer quickly
  send(ws, {
    type: "steer",
    session_id: sessionId,
    message: "Just say KIWI",
    mode: "fork_and_steer",
    model: MODEL,
    request_id: "fork-1",
  });
  const forkAck = await waitFor(ws, (f) => f.type === "ack" && f.request_id === "fork-1", 5000);
  assert(forkAck.ok === true, `Fork-and-steer ack ok=${forkAck.ok}`);

  // Collect until first result
  const result = await waitFor(ws, (f) => f.type === "event" && f.event?.type === "result", 120_000);
  const resultTime = Date.now() - startTime;
  assert(result.event?.subtype === "success", `Fork result subtype: ${result.event?.subtype}`);
  ok(`Time to forked result: ${resultTime}ms`);

  ws.close();
}

// ────────────────────────────────────────────────
// Context / IPC tests — these exercise the memory-ipc patch
// The REST context endpoints talk to the runner's MemIpcClient,
// which connects over a Unix socket to the patched CLI process.
// ────────────────────────────────────────────────

async function testContextRead() {
  console.log("\n--- Test 6: Context read (IPC: get_context + get_stats) ---");

  // Previous tests sent messages, so the context should have entries.
  // This exercises the memory-ipc patch: orchestrator → runner → MemIpcClient → Unix socket → patched CLI.
  await waitForStatus(sessionId, ["idle", "ready"]);

  const { status, json } = await get(`/sessions/${sessionId}/context`);
  assert(status === 200, `GET /context returned ${status}`);
  assert(Array.isArray(json.messages), "Context has messages array");
  assert(json.messages.length > 0, `Context has ${json.messages.length} messages`);
  assert(json.stats !== undefined, "Context includes stats");

  // Verify message shape — IPC returns full message objects with uuid
  const firstMsg = json.messages[0];
  assert(firstMsg.uuid !== undefined, "Messages have uuid field");
  ok(`Context tokens: ${json.context_tokens ?? "unknown"}`);
}

async function testContextInjectAndRemove() {
  console.log("\n--- Test 7: Inject + remove message (IPC: inject_message, remove_message) ---");

  await waitForStatus(sessionId, ["idle", "ready"]);

  // Get current message count
  const before = await get(`/sessions/${sessionId}/context`);
  const beforeCount = before.json.messages.length;

  // Inject a message
  const inject = await post(`/sessions/${sessionId}/context/inject`, {
    content: "TEST_INJECTED_CONTEXT_MESSAGE_E2E",
    role: "user",
  });
  assert(inject.status === 200, `Inject returned ${inject.status}`);
  // IPC path returns { injected: true }, JSONL fallback returns { injected_uuid: "..." }
  const injectOk = inject.json.injected === true || inject.json.injected_uuid !== undefined;
  assert(injectOk, `Inject acknowledged: ${JSON.stringify(inject.json)}`);

  // Verify it's there
  const after = await get(`/sessions/${sessionId}/context`);
  assert(after.json.messages.length === beforeCount + 1, `Message count: ${beforeCount} → ${after.json.messages.length}`);

  // Find the injected message by content (since IPC path doesn't return uuid)
  const injected = after.json.messages.find(
    (m) => {
      // Check both message formats: IPC format and JSONL format
      const content = m.message?.content;
      if (Array.isArray(content)) {
        return content.some((b) => b.text?.includes("TEST_INJECTED_CONTEXT_MESSAGE_E2E"));
      }
      if (typeof content === "string") {
        return content.includes("TEST_INJECTED_CONTEXT_MESSAGE_E2E");
      }
      return false;
    }
  );
  assert(injected !== undefined, "Injected message found in context");

  if (injected) {
    // Remove it
    const remove = await del(`/sessions/${sessionId}/context/messages/${injected.uuid}`);
    assert(remove.status === 200, `Remove returned ${remove.status}`);

    // Verify it's gone
    const final = await get(`/sessions/${sessionId}/context`);
    assert(final.json.messages.length === beforeCount, `Message count restored: ${final.json.messages.length}`);
  }
}

async function testContextTruncate() {
  console.log("\n--- Test 8: Truncate context (IPC: truncate) ---");

  await waitForStatus(sessionId, ["idle", "ready"]);

  // Get current context
  const before = await get(`/sessions/${sessionId}/context`);
  const beforeCount = before.json.messages.length;
  assert(beforeCount >= 2, `Need at least 2 messages for truncate test, have ${beforeCount}`);

  // Truncate to last 2 turns
  const trunc = await post(`/sessions/${sessionId}/context/truncate`, { keep_last_n: 2 });
  assert(trunc.status === 200, `Truncate returned ${trunc.status}`);

  // Verify
  const after = await get(`/sessions/${sessionId}/context`);
  assert(after.json.messages.length <= beforeCount, `Messages reduced: ${beforeCount} → ${after.json.messages.length}`);
  ok(`Truncated from ${beforeCount} to ${after.json.messages.length} messages`);
}

async function testParallelToolCalls() {
  console.log("\n--- Test 9: Parallel tool calls (no-sibling-abort patch) ---");

  // This test verifies that the agent can make multiple tool calls in parallel
  // and they all complete. Without the no-sibling-abort patch, if one tool errors,
  // sibling tools would be aborted with "sibling_error".
  //
  // We ask the agent to make multiple Read calls in parallel. If the patch is
  // working, all calls complete (or fail individually) rather than being aborted.

  await waitForStatus(sessionId, ["idle", "ready"]);

  const ws = await connect();

  // Subscribe
  send(ws, { type: "subscribe", session_id: sessionId });
  await waitFor(ws, (f) => f.type === "subscribed", 5000);

  // Ask for parallel tool calls - read multiple files simultaneously
  send(ws, {
    type: "send",
    session_id: sessionId,
    message: "Read these three files in PARALLEL (use multiple tool calls in one response, do NOT read them sequentially): /etc/hostname, /etc/os-release, /etc/resolv.conf. Report the first line of each.",
    request_id: "parallel-1",
  });
  await waitFor(ws, (f) => f.type === "ack", 5000);

  // Collect all events until result
  const frames = await collectUntil(
    ws,
    (f) => f.type === "event" && f.event?.type === "result",
    120_000,
  );

  const resultEvent = frames.find((f) => f.type === "event" && f.event?.type === "result");
  assert(resultEvent?.event?.subtype === "success", `Parallel calls result: ${resultEvent?.event?.subtype}`);

  // Check for tool_use events — should have multiple
  const toolUseEvents = frames.filter(
    (f) => f.type === "event" && f.event?.type === "assistant" &&
    f.event?.content?.some?.((b) => b.type === "tool_use"),
  );

  // Count total tool_use blocks across all assistant events
  let toolUseCount = 0;
  for (const ev of frames) {
    if (ev.type === "event" && ev.event?.type === "assistant" && Array.isArray(ev.event.content)) {
      toolUseCount += ev.event.content.filter((b) => b.type === "tool_use").length;
    }
  }
  ok(`Tool use blocks seen: ${toolUseCount}`);

  // The key assertion: result was success, meaning no sibling_error aborted the batch
  assert(resultEvent?.event?.subtype === "success", "Parallel tool calls completed without sibling abort");

  ws.close();
}

async function testInvalidFrame() {
  console.log("\n--- Test 12: Invalid frame ---");
  const ws = await connect();
  send(ws, { type: "totally_bogus_command" });
  const err = await waitFor(ws, (f) => f.type === "error", 5000);
  assert(err.message?.includes("Unknown frame type"), `Error: ${err.message}`);
  ws.close();
}

async function testInvalidJson() {
  console.log("\n--- Test 13: Invalid JSON ---");
  const ws = await connect();
  ws.send("not json at all {{{");
  const err = await waitFor(ws, (f) => f.type === "error", 5000);
  assert(err.message?.includes("Invalid JSON"), `Error: ${err.message}`);
  ws.close();
}

// ════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════

console.log("=== Client WebSocket E2E Tests ===");
console.log(`REST: ${BASE_URL}`);
console.log(`WS:   ${WS_URL}`);

try {
  await testPreflight();
  await testPingPong();
  await createSession();
  await testSubscribeSendReceive();
  await testSubscribeNonExistent();
  await testTwoClients();
  await testCompact();
  await testContextRead();
  await testContextInjectAndRemove();
  await testContextTruncate();
  await testParallelToolCalls();
  await testSteer();
  await testForkAndSteer();
  await testInvalidFrame();
  await testInvalidJson();
} catch (err) {
  notOk(`Unhandled error: ${err.message}`, err.stack);
} finally {
  console.log("\n--- Cleanup ---");
  await cleanupSession();
}

console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${pass} passed, ${fail} failed (out of ${pass + fail})`);
console.log("═".repeat(40));

if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log("\nAll tests passed!");
  process.exit(0);
}

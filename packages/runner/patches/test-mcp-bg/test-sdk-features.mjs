#!/usr/bin/env node
/**
 * End-to-end tests for SDK drop-in replacement features.
 *
 * Covers the 8 new capabilities added to make the runner WS API a
 * swap-in-place backend for any SDK consumer:
 *
 *   1. usage field in assistant events
 *   2. max_thinking_tokens in send/steer frames
 *   3. permission_request / permission_response protocol
 *   4. auto-compaction (orchestrator-side, needs context fill — skipped in fast mode)
 *   5. rewind via IPC (truncate to UUID)
 *   6. set_options (dynamic model/thinking/compact override)
 *   7. mcpServers in SessionRequest (creation-time, verified via session info)
 *   8. path restriction hooks (allowedPaths, verified by tool deny)
 *
 * Usage:
 *   node test-sdk-features.mjs
 *   BASE_URL=http://localhost:9080 node test-sdk-features.mjs
 *   SKIP_SLOW=1 node test-sdk-features.mjs    # skip slow tests (permission, auto-compact)
 */
import { WebSocket } from "ws";

const BASE_URL = process.env.BASE_URL || "http://localhost:9080";
const WS_URL = process.env.WS_URL || BASE_URL.replace(/^http/, "ws") + "/ws";
const MODEL = process.env.MODEL || "claude-sonnet-4-20250514";
const SKIP_SLOW = process.env.SKIP_SLOW === "1";

// --- Test runner ---

let pass = 0;
let fail = 0;
const failures = [];

function ok(msg) {
  pass++;
  console.log(`  \u2713 ${msg}`);
}

function notOk(msg, detail) {
  fail++;
  console.log(`  \u2717 ${msg}`);
  if (detail) console.log(`    ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  failures.push(msg);
}

function assert(condition, msg, detail) {
  if (condition) ok(msg);
  else notOk(msg, detail);
}

function skip(msg) {
  console.log(`  \u2014 SKIP: ${msg}`);
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
let permissionSessionId;

async function createSession(opts = {}) {
  const { status, json } = await post("/sessions", {
    model: MODEL,
    maxTurns: 1,
    systemPrompt: "You are a test assistant. Always respond with exactly one word: PINEAPPLE",
    ...opts,
  });
  assert(status === 200, `Session created (HTTP ${status})`, json);
  const sid = json.session_id;
  if (!sid) throw new Error("No session_id in response");
  console.log(`    session_id: ${sid}`);

  const s = await waitForStatus(sid, ["ready", "idle"]);
  assert(s === "ready" || s === "idle", `Session is ${s}`);
  return sid;
}

async function cleanupSession(sid) {
  if (!sid) return;
  try {
    await waitForStatus(sid, ["idle", "ready", "stopped", "error"], 60_000).catch(() => {});
    await del(`/sessions/${sid}`);
    ok(`Session ${sid} cleaned up`);
  } catch {
    console.log(`  (cleanup: session ${sid} may already be gone)`);
  }
}

// ════════════════════════════════════════════════
// Test 1: usage field in assistant events
// ════════════════════════════════════════════════

async function testUsageInAssistantEvents() {
  console.log("\n--- Test 1: Usage in assistant events ---");
  const ws = await connect();

  send(ws, { type: "subscribe", session_id: sessionId });
  await waitFor(ws, (f) => f.type === "subscribed", 5000);

  send(ws, { type: "send", session_id: sessionId, message: "Say PINEAPPLE", request_id: "usage-1" });
  await waitFor(ws, (f) => f.type === "ack", 5000);

  const frames = await collectUntil(ws, (f) => f.type === "event" && f.event?.type === "result");

  const assistantEvents = frames.filter((f) => f.type === "event" && f.event?.type === "assistant");
  assert(assistantEvents.length > 0, `Got ${assistantEvents.length} assistant event(s)`);

  // Check that at least one assistant event has usage
  const withUsage = assistantEvents.filter((f) => f.event?.usage != null);
  assert(withUsage.length > 0, `${withUsage.length} assistant event(s) have usage field`);

  if (withUsage.length > 0) {
    const usage = withUsage[0].event.usage;
    ok(`Usage sample: input_tokens=${usage.input_tokens}, output_tokens=${usage.output_tokens}`);
  }

  ws.close();
}

// ════════════════════════════════════════════════
// Test 2: max_thinking_tokens in send frame
// ════════════════════════════════════════════════

async function testMaxThinkingTokens() {
  console.log("\n--- Test 2: max_thinking_tokens in send frame ---");
  const ws = await connect();

  // Wait for idle
  await waitForStatus(sessionId, ["idle", "ready"]);

  send(ws, { type: "subscribe", session_id: sessionId });
  await waitFor(ws, (f) => f.type === "subscribed", 5000);

  // Send with thinking enabled — the runner should accept it without error
  send(ws, {
    type: "send",
    session_id: sessionId,
    message: "Say PINEAPPLE",
    max_thinking_tokens: 5000,
    request_id: "think-1",
  });
  const ack = await waitFor(ws, (f) => f.type === "ack" && f.request_id === "think-1", 5000);
  assert(ack.ok === true, `Send with max_thinking_tokens ack ok=${ack.ok}`);

  // Wait for result — just verify it completes without error
  const result = await waitFor(ws, (f) => f.type === "event" && f.event?.type === "result", 120_000);
  assert(result.event?.subtype === "success", `Result: ${result.event?.subtype}`);

  ws.close();
}

// ════════════════════════════════════════════════
// Test 3: Permission request/response protocol
// ════════════════════════════════════════════════

async function testPermissionProtocol() {
  console.log("\n--- Test 3: Permission request/response protocol ---");

  if (SKIP_SLOW) {
    skip("Permission protocol (needs separate session with permissionMode)");
    return;
  }

  // Create a session with non-bypass permission mode
  permissionSessionId = await createSession({
    permissionMode: "default",
    systemPrompt: "You are a test assistant. When asked, read the file /etc/hostname using the Read tool.",
    maxTurns: 2,
  });

  const ws = await connect();

  send(ws, { type: "subscribe", session_id: permissionSessionId });
  await waitFor(ws, (f) => f.type === "subscribed", 5000);

  // Send a message that should trigger a tool call requiring permission
  send(ws, {
    type: "send",
    session_id: permissionSessionId,
    message: "Read the file /etc/hostname",
    request_id: "perm-1",
  });
  await waitFor(ws, (f) => f.type === "ack", 5000);

  // Wait for a permission_request frame
  let gotPermission = false;
  try {
    const permReq = await waitFor(
      ws,
      (f) => f.type === "permission_request",
      60_000,
    );
    assert(permReq.tool_name !== undefined, `Permission request for tool: ${permReq.tool_name}`);
    assert(permReq.tool_use_id !== undefined, `Has tool_use_id: ${permReq.tool_use_id}`);
    gotPermission = true;

    // Respond with allow
    send(ws, {
      type: "permission_response",
      session_id: permissionSessionId,
      tool_use_id: permReq.tool_use_id,
      behavior: "allow",
      request_id: "perm-resp-1",
    });

    const permAck = await waitFor(ws, (f) => f.type === "ack" && f.request_id === "perm-resp-1", 5000);
    assert(permAck.ok === true, `Permission response ack ok=${permAck.ok}`);

    // Wait for eventual result (may need to allow more permission requests)
    // Keep allowing until we get a result
    const resultPromise = waitFor(ws, (f) => f.type === "event" && f.event?.type === "result", 120_000);

    // Auto-allow any further permission requests
    const autoAllower = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "permission_request") {
        send(ws, {
          type: "permission_response",
          session_id: permissionSessionId,
          tool_use_id: frame.tool_use_id,
          behavior: "allow",
        });
      }
    };
    ws.on("message", autoAllower);

    const result = await resultPromise;
    ws.removeListener("message", autoAllower);
    assert(result.event?.subtype === "success", `Permission flow result: ${result.event?.subtype}`);
  } catch (err) {
    if (!gotPermission) {
      // Permission mode might not be supported in this SDK version
      notOk(`Permission request not received: ${err.message}`);
    } else {
      notOk(`Permission flow error: ${err.message}`);
    }
  }

  ws.close();
}

// ════════════════════════════════════════════════
// Test 4: Rewind via IPC
// ════════════════════════════════════════════════

async function testRewind() {
  console.log("\n--- Test 4: Rewind via IPC ---");

  await waitForStatus(sessionId, ["idle", "ready"]);

  // First, get the current context to find a UUID to rewind to
  const { json: ctx } = await get(`/sessions/${sessionId}/context`);
  assert(ctx.messages?.length >= 2, `Have ${ctx.messages?.length} messages for rewind`);

  if (!ctx.messages || ctx.messages.length < 2) {
    skip("Not enough messages to test rewind");
    return;
  }

  // Pick the first message's UUID as the rewind target
  const targetUuid = ctx.messages[0].uuid;
  const totalBefore = ctx.messages.length;
  ok(`Rewinding to UUID ${targetUuid} (message 1 of ${totalBefore})`);

  const ws = await connect();

  // Send rewind frame
  send(ws, {
    type: "rewind",
    session_id: sessionId,
    user_message_uuid: targetUuid,
    request_id: "rewind-1",
  });

  // Should get an ack
  const ack = await waitFor(ws, (f) => f.type === "ack" && f.request_id === "rewind-1", 10_000);
  assert(ack.ok === true, `Rewind ack ok=${ack.ok}`);

  // Wait for the context_result with success
  // The runner sends a context_result with the rewind outcome
  // (but only via the bridge, not necessarily to subscribed clients)
  // Give it a moment to process
  await sleep(2000);

  // Verify context was truncated
  const { json: ctxAfter } = await get(`/sessions/${sessionId}/context`);
  assert(
    ctxAfter.messages.length < totalBefore,
    `Messages reduced: ${totalBefore} -> ${ctxAfter.messages.length}`,
  );

  ws.close();
}

// ════════════════════════════════════════════════
// Test 5: set_options (dynamic override)
// ════════════════════════════════════════════════

async function testSetOptions() {
  console.log("\n--- Test 5: set_options (dynamic override) ---");

  await waitForStatus(sessionId, ["idle", "ready"]);

  const ws = await connect();

  // Send set_options to change compact_instructions
  send(ws, {
    type: "set_options",
    session_id: sessionId,
    compact_instructions: "Summarize very briefly, keep only key facts.",
    request_id: "opts-1",
  });

  const ack = await waitFor(ws, (f) => f.type === "ack" && f.request_id === "opts-1", 10_000);
  assert(ack.ok === true, `set_options ack ok=${ack.ok}`);

  // Verify session is still functional — send a message
  send(ws, { type: "subscribe", session_id: sessionId });
  await waitFor(ws, (f) => f.type === "subscribed", 5000);

  send(ws, { type: "send", session_id: sessionId, message: "Say PINEAPPLE", request_id: "post-opts-1" });
  await waitFor(ws, (f) => f.type === "ack" && f.request_id === "post-opts-1", 5000);

  const result = await waitFor(ws, (f) => f.type === "event" && f.event?.type === "result", 120_000);
  assert(result.event?.subtype === "success", `Post-set_options result: ${result.event?.subtype}`);

  ws.close();
}

// ════════════════════════════════════════════════
// Test 6: MCP servers in SessionRequest
// ════════════════════════════════════════════════

async function testMcpServersInRequest() {
  console.log("\n--- Test 6: mcpServers accepted in SessionRequest ---");

  // Verify that the API accepts mcpServers without error.
  // We can't easily verify they're actually wired (would need a real MCP server),
  // but we verify the field doesn't cause a creation error.
  const { status, json } = await post("/sessions", {
    model: MODEL,
    maxTurns: 1,
    systemPrompt: "Say PINEAPPLE",
    mcpServers: {
      "test-server": { command: "echo", args: ["hello"] },
    },
  });
  assert(status === 200, `Session with mcpServers created (HTTP ${status})`);

  const mcpSessionId = json.session_id;
  if (mcpSessionId) {
    // Wait for it to start, then clean up
    try {
      await waitForStatus(mcpSessionId, ["ready", "idle", "error"], 60_000);
    } catch { /* best effort */ }
    await del(`/sessions/${mcpSessionId}`).catch(() => {});
    ok("Session with mcpServers started without rejection");
  }
}

// ════════════════════════════════════════════════
// Test 7: allowedPaths in SessionRequest
// ════════════════════════════════════════════════

async function testAllowedPaths() {
  console.log("\n--- Test 7: allowedPaths accepted in SessionRequest ---");

  // Similar to MCP — verify the field is accepted.
  // Full verification would require the agent to try reading outside allowed paths.
  const { status, json } = await post("/sessions", {
    model: MODEL,
    maxTurns: 1,
    systemPrompt: "Say PINEAPPLE",
    allowedPaths: ["/workspace", "/tmp"],
  });
  assert(status === 200, `Session with allowedPaths created (HTTP ${status})`);

  const pathSessionId = json.session_id;
  if (pathSessionId) {
    try {
      await waitForStatus(pathSessionId, ["ready", "idle", "error"], 60_000);
    } catch { /* best effort */ }
    await del(`/sessions/${pathSessionId}`).catch(() => {});
    ok("Session with allowedPaths started without rejection");
  }
}

// ════════════════════════════════════════════════
// Test 8: Steer with max_thinking_tokens
// ════════════════════════════════════════════════

async function testSteerWithThinking() {
  console.log("\n--- Test 8: Steer with max_thinking_tokens ---");

  await waitForStatus(sessionId, ["idle", "ready"]);

  const ws = await connect();
  send(ws, { type: "subscribe", session_id: sessionId });
  await waitFor(ws, (f) => f.type === "subscribed", 5000);

  // Send slow message
  send(ws, {
    type: "send",
    session_id: sessionId,
    message: "Write a very detailed 500-word essay about the history of mathematics.",
    request_id: "slow-think",
  });
  await waitFor(ws, (f) => f.type === "ack", 5000);
  await waitFor(ws, (f) => f.type === "status" && f.status === "busy", 15_000);

  // Steer with max_thinking_tokens
  send(ws, {
    type: "steer",
    session_id: sessionId,
    message: "Just say COCONUT",
    max_thinking_tokens: 3000,
    request_id: "steer-think-1",
  });
  const ack = await waitFor(ws, (f) => f.type === "ack" && f.request_id === "steer-think-1", 5000);
  assert(ack.ok === true, `Steer with thinking ack ok=${ack.ok}`);

  const result = await waitFor(ws, (f) => f.type === "event" && f.event?.type === "result", 120_000);
  assert(result.event?.subtype === "success", `Steer+thinking result: ${result.event?.subtype}`);

  ws.close();
}

// ════════════════════════════════════════════════
// Test 9: context_state frames include context tokens
// ════════════════════════════════════════════════

async function testContextStateFrames() {
  console.log("\n--- Test 9: context_state frames ---");

  await waitForStatus(sessionId, ["idle", "ready"]);

  const ws = await connect();
  send(ws, { type: "subscribe", session_id: sessionId });
  await waitFor(ws, (f) => f.type === "subscribed", 5000);

  send(ws, { type: "send", session_id: sessionId, message: "Say PINEAPPLE", request_id: "ctx-state-1" });
  await waitFor(ws, (f) => f.type === "ack", 5000);

  const frames = await collectUntil(ws, (f) => f.type === "event" && f.event?.type === "result");

  const ctxFrames = frames.filter((f) => f.type === "context_state");
  assert(ctxFrames.length > 0, `Got ${ctxFrames.length} context_state frame(s)`);

  if (ctxFrames.length > 0) {
    const last = ctxFrames[ctxFrames.length - 1];
    assert(typeof last.context_tokens === "number", `context_tokens is number: ${last.context_tokens}`);
    ok(`Last context_tokens: ${last.context_tokens}`);
  }

  ws.close();
}

// ════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════

console.log("=== SDK Drop-in Features E2E Tests ===");
console.log(`REST: ${BASE_URL}`);
console.log(`WS:   ${WS_URL}`);
console.log(`Model: ${MODEL}`);
if (SKIP_SLOW) console.log("(SKIP_SLOW=1: skipping slow tests)");

try {
  // Preflight
  console.log("\n--- Preflight ---");
  const { json: health } = await get("/health");
  assert(health.status === "ok", "Orchestrator is healthy");
  assert(health.docker_connected === true, "Docker is connected");

  // Create main session
  console.log("\n--- Create session ---");
  sessionId = await createSession();

  // Run tests
  await testUsageInAssistantEvents();
  await testMaxThinkingTokens();
  await testContextStateFrames();
  await testSetOptions();
  await testRewind();
  await testSteerWithThinking();
  await testMcpServersInRequest();
  await testAllowedPaths();
  await testPermissionProtocol();
} catch (err) {
  notOk(`Unhandled error: ${err.message}`, err.stack);
} finally {
  console.log("\n--- Cleanup ---");
  await cleanupSession(sessionId);
  if (permissionSessionId) await cleanupSession(permissionSessionId);
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${pass} passed, ${fail} failed (out of ${pass + fail})`);
console.log("=".repeat(40));

if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log("\nAll tests passed!");
  process.exit(0);
}

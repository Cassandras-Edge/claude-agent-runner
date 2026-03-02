#!/usr/bin/env node
/**
 * End-to-end tests for the client-facing WebSocket API.
 *
 * Runs against a live orchestrator (requires docker compose up).
 * Tests the full pipeline: client WS → orchestrator → real runner (Claude).
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
  return { status: res.status };
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
  console.log("\n--- Test 6: Steer (abort + resume) ---");
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
  console.log("\n--- Test 7: Fork-and-steer (fork while busy) ---");

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

async function testInvalidFrame() {
  console.log("\n--- Test 8: Invalid frame type ---");
  const ws = await connect();
  send(ws, { type: "totally_bogus_command" });
  const err = await waitFor(ws, (f) => f.type === "error", 5000);
  assert(err.message?.includes("Unknown frame type"), `Error: ${err.message}`);
  ws.close();
}

async function testInvalidJson() {
  console.log("\n--- Test 9: Invalid JSON ---");
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

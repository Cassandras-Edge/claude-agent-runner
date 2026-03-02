#!/usr/bin/env bash
# End-to-end test for the client-facing WebSocket API.
# Prerequisites: docker compose up (orchestrator must be running)
#
# Tests the full lifecycle against the real running orchestrator:
#   1. WS connect + ping/pong
#   2. Create session via REST
#   3. Subscribe via WS, receive status
#   4. Send message via WS, receive streamed events + result
#   5. Subscribe error for non-existent session
#   6. Two clients watching same session
#   7. Compact via WS
#   8. Invalid frame handling
#
# Usage: bash test-client-ws.sh [BASE_URL]
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:9080}"
WS_URL="${WS_URL:-ws://localhost:9080/ws}"
MODEL="${MODEL:-claude-sonnet-4-20250514}"
PASS=0
FAIL=0
TOTAL=0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ✗ $1"; echo "    $2"; }

echo "=== Client WebSocket E2E Test ==="
echo "REST: $BASE_URL"
echo "WS:   $WS_URL"
echo ""

# --- Test 0: Health check ---
echo "--- Preflight ---"
HEALTH=$(curl -sf "$BASE_URL/health" 2>/dev/null || echo '{"status":"error"}')
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
if [ "$STATUS" = "ok" ]; then
  pass "Orchestrator is healthy"
else
  fail "Orchestrator health check failed" "$HEALTH"
  echo "Is docker compose up running?"
  exit 1
fi
echo ""

# --- Test 1: WebSocket connect + ping/pong ---
echo "--- Test 1: Connect + Ping/Pong ---"

PONG_RESULT=$(node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('$WS_URL');
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 10000);
ws.on('open', () => {
  console.log('CONNECTED');
  ws.send(JSON.stringify({type:'ping'}));
});
ws.on('message', (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === 'pong') {
    console.log('PONG_OK');
    clearTimeout(timer);
    ws.close();
  }
});
ws.on('error', (e) => { console.log('ERROR:' + e.message); process.exit(1); });
" 2>&1) || true

if echo "$PONG_RESULT" | grep -q "CONNECTED"; then
  pass "WebSocket connected to $WS_URL"
else
  fail "WebSocket connection failed" "$PONG_RESULT"
  exit 1
fi

if echo "$PONG_RESULT" | grep -q "PONG_OK"; then
  pass "Ping/pong works"
else
  fail "Ping/pong failed" "$PONG_RESULT"
fi
echo ""

# --- Test 2: Create a session via REST ---
echo "--- Test 2: Create session (REST, no message) ---"
CREATE_RESPONSE=$(curl -sf -X POST "$BASE_URL/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'$MODEL'",
    "maxTurns": 1,
    "systemPrompt": "You are a test assistant. Always respond with exactly one word: PINEAPPLE"
  }' 2>/dev/null || echo '{"error":"create_failed"}')

SESSION_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "None" ]; then
  pass "Session created: $SESSION_ID"
else
  fail "Failed to create session" "$CREATE_RESPONSE"
  exit 1
fi

# Wait for session to be ready
for i in $(seq 1 30); do
  S_STATUS=$(curl -sf "$BASE_URL/sessions/$SESSION_ID" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
  if [ "$S_STATUS" = "ready" ] || [ "$S_STATUS" = "idle" ]; then
    break
  fi
  sleep 1
done

S_STATUS=$(curl -sf "$BASE_URL/sessions/$SESSION_ID" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "unknown")
if [ "$S_STATUS" = "ready" ] || [ "$S_STATUS" = "idle" ]; then
  pass "Session is $S_STATUS"
else
  fail "Session not ready (status: $S_STATUS)" ""
fi
echo ""

# --- Test 3: Subscribe + send + receive events ---
echo "--- Test 3: Subscribe, send message, receive events ---"

# This node script does: connect → subscribe → send → collect events until result
T3_RESULT=$(node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('$WS_URL');
const timer = setTimeout(() => { console.log(JSON.stringify({timeout:true})); ws.close(); process.exit(0); }, 120000);
const frames = [];
let phase = 'connecting';

ws.on('open', () => {
  phase = 'subscribing';
  ws.send(JSON.stringify({type:'subscribe', session_id:'$SESSION_ID', request_id:'sub-1'}));
});

ws.on('message', (data) => {
  const f = JSON.parse(data.toString());

  if (phase === 'subscribing' && f.type === 'subscribed') {
    console.log(JSON.stringify({subscribed: true, status: f.status, request_id: f.request_id}));
    phase = 'sending';
    ws.send(JSON.stringify({type:'send', session_id:'$SESSION_ID', message:'Say PINEAPPLE', request_id:'msg-1'}));
    return;
  }

  if (phase === 'sending' && f.type === 'ack') {
    console.log(JSON.stringify({ack: true, ok: f.ok, request_id: f.request_id}));
    phase = 'collecting';
    return;
  }

  if (phase === 'collecting') {
    frames.push({type: f.type, event_type: f.event?.type, event_subtype: f.event?.subtype, status: f.status});
    if (f.type === 'event' && f.event?.type === 'result') {
      console.log(JSON.stringify({
        result: true,
        subtype: f.event.subtype,
        frame_count: frames.length,
        has_status: frames.some(x => x.type === 'status'),
        has_assistant: frames.some(x => x.event_type === 'assistant'),
        has_result: frames.some(x => x.event_type === 'result'),
        statuses: frames.filter(x => x.type === 'status').map(x => x.status),
        event_types: [...new Set(frames.filter(x => x.type === 'event').map(x => x.event_type))],
      }));
      clearTimeout(timer);
      ws.close();
    }
  }
});

ws.on('error', (e) => { console.log(JSON.stringify({error: e.message})); process.exit(1); });
" 2>&1) || true

# Parse subscribe
if echo "$T3_RESULT" | grep -q '"subscribed":true'; then
  SUB_STATUS=$(echo "$T3_RESULT" | grep '"subscribed":true' | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "?")
  pass "Subscribed (status: $SUB_STATUS)"
else
  fail "Subscribe failed" "$T3_RESULT"
fi

# Parse ack
if echo "$T3_RESULT" | grep -q '"ack":true'; then
  ACK_OK=$(echo "$T3_RESULT" | grep '"ack":true' | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || echo "?")
  pass "Send ack received (ok=$ACK_OK)"
else
  fail "No send ack" "$T3_RESULT"
fi

# Parse result
if echo "$T3_RESULT" | grep -q '"result":true'; then
  RESULT_LINE=$(echo "$T3_RESULT" | grep '"result":true')
  R_SUBTYPE=$(echo "$RESULT_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('subtype',''))" 2>/dev/null || echo "?")
  R_FRAMES=$(echo "$RESULT_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('frame_count',0))" 2>/dev/null || echo "0")
  R_HAS_STATUS=$(echo "$RESULT_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('has_status',False))" 2>/dev/null || echo "False")
  R_HAS_ASST=$(echo "$RESULT_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('has_assistant',False))" 2>/dev/null || echo "False")
  R_STATUSES=$(echo "$RESULT_LINE" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('statuses',[])))" 2>/dev/null || echo "")
  R_EVENTS=$(echo "$RESULT_LINE" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('event_types',[])))" 2>/dev/null || echo "")

  pass "Result received (subtype=$R_SUBTYPE, $R_FRAMES frames)"
  [ "$R_HAS_STATUS" = "True" ] && pass "Got status transitions: [$R_STATUSES]" || fail "No status events" ""
  [ "$R_HAS_ASST" = "True" ] && pass "Got assistant events" || fail "No assistant events" ""
  pass "Event types seen: [$R_EVENTS]"
else
  fail "No result event received" "$T3_RESULT"
fi
echo ""

# --- Test 4: Subscribe to non-existent session ---
echo "--- Test 4: Subscribe to non-existent session ---"
T4_RESULT=$(node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('$WS_URL');
const timer = setTimeout(() => { console.log('TIMEOUT'); ws.close(); }, 5000);
ws.on('open', () => {
  ws.send(JSON.stringify({type:'subscribe', session_id:'does-not-exist-xyz'}));
});
ws.on('message', (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === 'error') {
    console.log('ERROR_CODE:' + f.error_code);
    clearTimeout(timer);
    ws.close();
  }
});
ws.on('error', (e) => console.log('WS_ERROR:' + e.message));
" 2>&1) || true

if echo "$T4_RESULT" | grep -q "ERROR_CODE:session_not_found"; then
  pass "Non-existent session returns session_not_found"
else
  fail "Expected session_not_found" "$T4_RESULT"
fi
echo ""

# --- Test 5: Two clients, same session ---
echo "--- Test 5: Two clients watching same session ---"
T5_RESULT=$(node -e "
const { WebSocket } = require('ws');

// Both clients connect and subscribe
const ws1 = new WebSocket('$WS_URL');
const ws2 = new WebSocket('$WS_URL');
const timer = setTimeout(() => { console.log('TIMEOUT'); ws1.close(); ws2.close(); process.exit(0); }, 120000);
let c1_got_event = false, c2_got_event = false;

function tryDone() {
  if (c1_got_event && c2_got_event) {
    console.log('BOTH_GOT_EVENTS');
    clearTimeout(timer);
    ws1.close();
    ws2.close();
  }
}

ws1.on('open', () => ws1.send(JSON.stringify({type:'subscribe', session_id:'$SESSION_ID'})));
ws2.on('open', () => ws2.send(JSON.stringify({type:'subscribe', session_id:'$SESSION_ID'})));

let ws2_subscribed = false;
ws2.on('message', (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === 'subscribed' && !ws2_subscribed) {
    ws2_subscribed = true;
    // Send a message from ws2
    setTimeout(() => {
      ws2.send(JSON.stringify({type:'send', session_id:'$SESSION_ID', message:'Say BANANA', request_id:'multi-1'}));
    }, 500);
  }
  if (f.type === 'event' && f.event?.type === 'result') {
    c2_got_event = true;
    console.log('C2_RESULT');
    tryDone();
  }
});

ws1.on('message', (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === 'event' && f.event?.type === 'result') {
    c1_got_event = true;
    console.log('C1_RESULT');
    tryDone();
  }
});

ws1.on('error', (e) => console.log('WS1_ERROR:' + e.message));
ws2.on('error', (e) => console.log('WS2_ERROR:' + e.message));
" 2>&1) || true

if echo "$T5_RESULT" | grep -q "BOTH_GOT_EVENTS"; then
  pass "Both clients received result events"
elif echo "$T5_RESULT" | grep -q "C1_RESULT" && echo "$T5_RESULT" | grep -q "C2_RESULT"; then
  pass "Both clients received result events"
else
  C1=$(echo "$T5_RESULT" | grep -c "C1_RESULT" || true)
  C2=$(echo "$T5_RESULT" | grep -c "C2_RESULT" || true)
  fail "Not all clients got events (C1=$C1, C2=$C2)" "$T5_RESULT"
fi
echo ""

# --- Test 6: Compact via WS ---
echo "--- Test 6: Compact command ---"
T6_RESULT=$(node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('$WS_URL');
const timer = setTimeout(() => { console.log('TIMEOUT'); ws.close(); }, 10000);
ws.on('open', () => {
  ws.send(JSON.stringify({type:'compact', session_id:'$SESSION_ID', request_id:'cpt-1'}));
});
ws.on('message', (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === 'ack') {
    console.log('ACK_OK:' + f.ok);
    clearTimeout(timer);
    ws.close();
  }
});
ws.on('error', (e) => console.log('WS_ERROR:' + e.message));
" 2>&1) || true

if echo "$T6_RESULT" | grep -q "ACK_OK:true"; then
  pass "Compact ack received (ok=true)"
else
  fail "Compact ack issue" "$T6_RESULT"
fi
echo ""

# --- Test 7: Invalid frame ---
echo "--- Test 7: Invalid frame type ---"
T7_RESULT=$(node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('$WS_URL');
const timer = setTimeout(() => { console.log('TIMEOUT'); ws.close(); }, 5000);
ws.on('open', () => {
  ws.send(JSON.stringify({type:'totally_bogus_command'}));
});
ws.on('message', (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === 'error') {
    console.log('GOT_ERROR:' + f.message);
    clearTimeout(timer);
    ws.close();
  }
});
ws.on('error', (e) => console.log('WS_ERROR:' + e.message));
" 2>&1) || true

if echo "$T7_RESULT" | grep -q "GOT_ERROR:"; then
  pass "Invalid frame returns error"
else
  fail "No error for invalid frame" "$T7_RESULT"
fi
echo ""

# --- Test 8: Invalid JSON ---
echo "--- Test 8: Invalid JSON ---"
T8_RESULT=$(node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('$WS_URL');
const timer = setTimeout(() => { console.log('TIMEOUT'); ws.close(); }, 5000);
ws.on('open', () => {
  ws.send('not json at all {{{');
});
ws.on('message', (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === 'error') {
    console.log('GOT_ERROR:' + f.message);
    clearTimeout(timer);
    ws.close();
  }
});
ws.on('error', (e) => console.log('WS_ERROR:' + e.message));
" 2>&1) || true

if echo "$T8_RESULT" | grep -q "GOT_ERROR:"; then
  pass "Invalid JSON returns error"
else
  fail "No error for invalid JSON" "$T8_RESULT"
fi
echo ""

# --- Cleanup ---
echo "--- Cleanup ---"
curl -sf -X DELETE "$BASE_URL/sessions/$SESSION_ID" > /dev/null 2>&1 && pass "Session deleted" || fail "Session delete failed" ""

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed (out of $TOTAL)"
echo "================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
else
  echo "All tests passed!"
  exit 0
fi

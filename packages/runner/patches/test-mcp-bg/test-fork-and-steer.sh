#!/usr/bin/env bash
# End-to-end test for fork-and-steer via the client WebSocket API.
# Prerequisites: docker compose up
#
# Flow:
#   1. Create session via REST (blocking, quick first message)
#   2. Subscribe via WS, send a slow message, wait for busy
#   3. Send fork_and_steer via WS while busy
#   4. Verify the forked foreground answers quickly
#   5. Optionally wait for background completion events
#
# Usage: bash test-fork-and-steer.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:9080}"
WS_URL="${WS_URL:-ws://localhost:9080/ws}"
MODEL="${MODEL:-claude-sonnet-4-20250514}"

echo "=== Fork-and-Steer E2E Test (WebSocket) ==="
echo "Base URL: $BASE_URL"
echo "WS URL:   $WS_URL"
echo ""

# 1. Create a session (blocking, quick first message to establish it)
echo "Step 1: Creating session..."
CREATE_RESPONSE=$(curl -s -X POST "$BASE_URL/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Say hello in one word.",
    "model": "'$MODEL'",
    "maxTurns": 1,
    "systemPrompt": "You are a coding assistant. Be concise."
  }')

SESSION_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
if [ -z "$SESSION_ID" ]; then
  echo "ERROR: Failed to create session"
  echo "$CREATE_RESPONSE"
  exit 1
fi
echo "Session ID: $SESSION_ID"
echo ""

# 2-4. Subscribe, send slow message, fork-and-steer, collect results — all via WS
echo "Step 2: Subscribe + slow message + fork_and_steer (via WebSocket)..."
WS_RESULT=$(node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('$WS_URL');
const startTime = Date.now();
const timer = setTimeout(() => {
  console.log(JSON.stringify({timeout: true, elapsed_ms: Date.now() - startTime}));
  ws.close();
  process.exit(0);
}, 180000);

let phase = 'subscribing';
let forkAckOk = false;
let resultCount = 0;
const allFrames = [];

ws.on('open', () => {
  ws.send(JSON.stringify({type:'subscribe', session_id:'$SESSION_ID'}));
});

ws.on('message', (data) => {
  const f = JSON.parse(data.toString());
  const elapsed = Date.now() - startTime;
  allFrames.push({type: f.type, event_type: f.event?.type, event_subtype: f.event?.subtype, status: f.status, elapsed_ms: elapsed});

  // Phase 1: Subscribe
  if (phase === 'subscribing' && f.type === 'subscribed') {
    console.log(JSON.stringify({phase: 'subscribed', status: f.status, elapsed_ms: elapsed}));
    phase = 'sending_slow';
    // Send a slow message to make the session busy
    ws.send(JSON.stringify({
      type: 'send',
      session_id: '$SESSION_ID',
      message: 'Write a COMPLETE implementation of a red-black tree in TypeScript. Include all rotations, insert with fix-up, delete with fix-up, search, min, max, in-order traversal, and comprehensive JSDoc comments. This should be production-quality code, at least 300 lines. Take your time and be thorough.',
      request_id: 'slow-msg'
    }));
    return;
  }

  // Phase 2: Wait for ack then busy status
  if (phase === 'sending_slow' && f.type === 'ack') {
    console.log(JSON.stringify({phase: 'slow_ack', ok: f.ok, elapsed_ms: elapsed}));
    phase = 'wait_busy';
    return;
  }

  if (phase === 'wait_busy' && f.type === 'status' && f.status === 'busy') {
    console.log(JSON.stringify({phase: 'session_busy', elapsed_ms: elapsed}));
    phase = 'forking';
    // Send fork_and_steer while busy
    ws.send(JSON.stringify({
      type: 'steer',
      session_id: '$SESSION_ID',
      message: 'Quick: what is 2 + 2? Answer in one word.',
      mode: 'fork_and_steer',
      model: '$MODEL',
      request_id: 'fork-steer-1'
    }));
    return;
  }

  // Phase 3: Fork ack
  if (phase === 'forking' && f.type === 'ack') {
    forkAckOk = f.ok;
    console.log(JSON.stringify({phase: 'fork_ack', ok: f.ok, elapsed_ms: elapsed}));
    phase = 'collecting';
    return;
  }

  // Phase 4: Collect until we get a result
  if (phase === 'collecting') {
    if (f.type === 'event' && f.event?.type === 'result') {
      resultCount++;
      console.log(JSON.stringify({
        phase: 'result',
        result_number: resultCount,
        subtype: f.event.subtype,
        elapsed_ms: elapsed,
        fork_ack_ok: forkAckOk,
        total_frames: allFrames.length,
        has_assistant: allFrames.some(x => x.event_type === 'assistant'),
        event_types: [...new Set(allFrames.filter(x => x.type === 'event').map(x => x.event_type))],
        result_text_preview: (f.event.result || '').substring(0, 200),
      }));

      // After first result, wait a bit longer for potential background_complete
      if (resultCount === 1) {
        setTimeout(() => {
          console.log(JSON.stringify({
            phase: 'done',
            total_results: resultCount,
            total_frames: allFrames.length,
          }));
          clearTimeout(timer);
          ws.close();
        }, 5000);
      }
    }
  }
});

ws.on('error', (e) => { console.log(JSON.stringify({error: e.message})); process.exit(1); });
" 2>&1)

echo ""
echo "=== Results ==="
echo "$WS_RESULT" | while IFS= read -r line; do
  echo "  $line"
done

echo ""

# Check results
FORK_ACK=$(echo "$WS_RESULT" | grep '"phase":"fork_ack"' | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok','?'))" 2>/dev/null || echo "?")
RESULT_LINE=$(echo "$WS_RESULT" | grep '"phase":"result"' | head -1)
RESULT_SUBTYPE=$(echo "$RESULT_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('subtype','?'))" 2>/dev/null || echo "?")
RESULT_ELAPSED=$(echo "$RESULT_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('elapsed_ms',0))" 2>/dev/null || echo "?")

echo "--- Summary ---"
echo "Fork ack:       ok=$FORK_ACK"
echo "Result subtype: $RESULT_SUBTYPE"
echo "Time to result: ${RESULT_ELAPSED}ms"

if [ "$FORK_ACK" = "True" ]; then
  echo "PASS: fork_and_steer was accepted"
else
  echo "FAIL: fork_and_steer was not accepted"
fi

if [ "$RESULT_SUBTYPE" = "success" ]; then
  echo "PASS: Got successful result from forked session"
else
  echo "FAIL: Result subtype was '$RESULT_SUBTYPE'"
fi

echo ""
echo "=== Test Complete ==="

#!/usr/bin/env bash
# End-to-end test for fork-and-steer.
# Prerequisites: docker compose up
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:9080}"
MODEL="${MODEL:-claude-sonnet-4-20250514}"

echo "=== Fork-and-Steer E2E Test ==="
echo "Base URL: $BASE_URL"
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

# 2. Send a slow message (SSE stream — runs in background)
echo "Step 2: Sending slow message (streaming in background)..."
# Use a temp file to capture the SSE stream
SSE_OUTPUT=$(mktemp)
curl -s -N -X POST "$BASE_URL/sessions/$SESSION_ID/messages/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Write a COMPLETE implementation of a red-black tree in TypeScript. Include all rotations, insert with fix-up, delete with fix-up, search, min, max, in-order traversal, and comprehensive JSDoc comments. This should be production-quality code, at least 300 lines. Take your time and be thorough.",
    "model": "'$MODEL'",
    "maxTurns": 3
  }' > "$SSE_OUTPUT" 2>&1 &
SSE_PID=$!

# 3. Wait for session to become busy
echo "Waiting for session to become busy..."
for i in $(seq 1 15); do
  STATUS=$(curl -s "$BASE_URL/sessions/$SESSION_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
  if [ "$STATUS" = "busy" ]; then
    echo "Session is busy (after ${i}s)"
    break
  fi
  sleep 1
done

STATUS=$(curl -s "$BASE_URL/sessions/$SESSION_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "unknown")
if [ "$STATUS" != "busy" ]; then
  echo "WARNING: Session status is '$STATUS' (expected 'busy'). Test may not exercise fork-and-steer properly."
fi

# 4. Send fork_and_steer while busy
echo ""
echo "Step 3: Sending fork_and_steer..."
STEER_RESPONSE=$(curl -s -X POST "$BASE_URL/sessions/$SESSION_ID/context/steer" \
  -H "Content-Type: application/json" \
  -H "x-request-id: test-fas-steer" \
  -d '{
    "message": "Quick: what is 2 + 2?",
    "mode": "fork_and_steer",
    "model": "'$MODEL'",
    "maxTurns": 1
  }')

echo "Steer response: $STEER_RESPONSE"
WAS_BUSY=$(echo "$STEER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('was_busy',False))" 2>/dev/null || echo "?")
MODE=$(echo "$STEER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode','?'))" 2>/dev/null || echo "?")
echo "Was busy: $WAS_BUSY | Mode: $MODE"

# 5. Wait for things to settle
echo ""
echo "Step 4: Waiting for completion..."
sleep 20

# Kill the background SSE curl
kill $SSE_PID 2>/dev/null || true
wait $SSE_PID 2>/dev/null || true

# 6. Check final state
echo ""
echo "Step 5: Checking results..."

# Check SSE output for evidence of forking
echo "--- SSE stream output (last 20 lines) ---"
tail -20 "$SSE_OUTPUT"

# Check session status
FINAL=$(curl -s "$BASE_URL/sessions/$SESSION_ID")
FINAL_STATUS=$(echo "$FINAL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "?")
echo ""
echo "Final session status: $FINAL_STATUS"

# Check for fork_and_steer or background_complete events in the stream
echo ""
echo "--- Checking for fork-and-steer events ---"
if grep -q "fork_and_steer" "$SSE_OUTPUT" 2>/dev/null; then
  echo "PASS: fork_and_steer event found in stream"
  grep "fork_and_steer" "$SSE_OUTPUT" | head -3
else
  echo "INFO: No fork_and_steer event in stream (may be expected depending on timing)"
fi

if grep -q "background_complete" "$SSE_OUTPUT" 2>/dev/null; then
  echo "PASS: background_complete event found"
  grep "background_complete" "$SSE_OUTPUT" | head -3
else
  echo "INFO: No background_complete event (background may still be running)"
fi

if grep -q "2 + 2\|four\|= 4" "$SSE_OUTPUT" 2>/dev/null; then
  echo "PASS: Quick question was answered (found math answer in stream)"
else
  echo "INFO: Quick question answer not found in stream output"
fi

# Cleanup
rm -f "$SSE_OUTPUT"

echo ""
echo "=== Test Complete ==="

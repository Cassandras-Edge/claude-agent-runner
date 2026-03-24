#!/bin/bash
set -e

# Copy authorized_keys from read-only secret mount with correct ownership
if [ -f /etc/ssh/cass-authorized-keys ]; then
  sudo cp /etc/ssh/cass-authorized-keys /home/runner/.ssh/authorized_keys
  sudo chown runner:node /home/runner/.ssh/authorized_keys
  chmod 600 /home/runner/.ssh/authorized_keys
fi

# Start SSH server (requires root via sudo)
sudo /usr/sbin/sshd -e

cd /app

# Prepare Claude config for skipping onboarding/trust dialogs
WORKSPACE="${RUNNER_WORKSPACE:-/workspace}"
mkdir -p "$WORKSPACE"
mkdir -p "$HOME/.claude/debug" "$HOME/.claude/plugins"

# Skip onboarding + trust dialogs
cat > "$HOME/.claude.json" <<CJSON
{"hasCompletedOnboarding":true,"hasSeenOnboardingTip":true,"theme":"dark","projects":{"$WORKSPACE":{"hasTrustDialogAccepted":true}}}
CJSON

PROJECT_DIR="$HOME/.claude/projects/-${WORKSPACE//\//-}"
PROJECT_DIR="${PROJECT_DIR/#--/-}"
mkdir -p "$PROJECT_DIR"
[ -f "$PROJECT_DIR/settings.json" ] || echo '{"hasTrustDialogAccepted":true}' > "$PROJECT_DIR/settings.json"

# Build Claude Code args
CLAUDE_ARGS="--dangerously-skip-permissions"
[ -n "$RUNNER_MODEL" ] && CLAUDE_ARGS="$CLAUDE_ARGS --model $RUNNER_MODEL"
[ -n "$RUNNER_SYSTEM_PROMPT" ] && CLAUDE_ARGS="$CLAUDE_ARGS --system-prompt \"$RUNNER_SYSTEM_PROMPT\""
[ -d "$WORKSPACE" ] && CLAUDE_ARGS="$CLAUDE_ARGS --add-dir $WORKSPACE"

# Determine executable
if [ -n "$CLAUDE_PATCHED_CLI" ]; then
  CLAUDE_CMD="bun $CLAUDE_PATCHED_CLI $CLAUDE_ARGS"
else
  CLAUDE_CMD="claude $CLAUDE_ARGS"
fi

# Export env for Claude Code (same as buildClaudeChildEnv)
export TERM=xterm-256color
export LANG=en_US.UTF-8
export ENABLE_TOOL_SEARCH=false

# Start Claude Code in tmux for SSH attach
tmux new-session -d -s claude
tmux send-keys -t claude "$CLAUDE_CMD" Enter

# Start the runner process (connects back to orchestrator via WebSocket)
# Runner handles headless SDK operations; the tmux session is for interactive SSH
node packages/runner/dist/index.js &
RUNNER_PID=$!

# Wait for the runner process — if it exits, the pod stops
wait $RUNNER_PID

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

# Ensure workspace exists
mkdir -p "${RUNNER_WORKSPACE:-/workspace}"

# Create tmux session for TUI output — the tui-pty patch redirects Ink
# rendering here while stream-json stays on stdin/stdout for the SDK.
# The pane runs sleep so it doesn't compete for PTY input with Ink.
tmux new-session -d -s claude 'sleep infinity'
CLAUDE_TUI_PTY=$(tmux display-message -p -t claude '#{pane_tty}')
export CLAUDE_TUI_PTY

# Start the runner — SDK spawns Claude Code with CLAUDE_TUI_PTY in env,
# tui-pty patch renders Ink to the tmux PTY. SSH users `tmux attach -t claude`.
cd /app
exec node packages/runner/dist/index.js

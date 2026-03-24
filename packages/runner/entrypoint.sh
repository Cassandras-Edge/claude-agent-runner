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

# tmux config for proper Unicode rendering
cat > ~/.tmux.conf << 'TMUXCONF'
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -gq utf8 on
set -gq mouse on
TMUXCONF

# Create tmux session for TUI — spawnClaudeCodeProcess replaces the pane
# with interactive Claude Code. SSH users attach via `tmux attach -t claude`.
tmux new-session -d -s claude 'sleep infinity'
CLAUDE_TUI_PTY=$(tmux display-message -p -t claude '#{pane_tty}')
export CLAUDE_TUI_PTY

# Start the runner — SDK spawns Claude Code with CLAUDE_TUI_PTY in env,
# tui-pty patch renders Ink to the tmux PTY. SSH users `tmux attach -t claude`.
cd /app
exec node packages/runner/dist/index.js

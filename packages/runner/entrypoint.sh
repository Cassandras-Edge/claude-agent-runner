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

# Persist .claude.json on the PVC — symlink to .claude/ which is PVC-mounted
if [ ! -L "$HOME/.claude.json" ] && [ -d "$HOME/.claude" ]; then
  # If a real .claude.json exists on the PVC, copy it out first
  if [ -f "$HOME/.claude/.claude.json" ] && [ ! -f "$HOME/.claude.json" ]; then
    cp "$HOME/.claude/.claude.json" "$HOME/.claude.json"
  fi
  # Move existing .claude.json to PVC if it exists
  if [ -f "$HOME/.claude.json" ]; then
    cp "$HOME/.claude.json" "$HOME/.claude/.claude.json"
  fi
  # Symlink so Claude Code reads/writes to the PVC copy
  rm -f "$HOME/.claude.json"
  ln -s "$HOME/.claude/.claude.json" "$HOME/.claude.json"
fi

export TERM=xterm-256color

# tmux config for proper Unicode rendering + passthrough
cat > ~/.tmux.conf << 'TMUXCONF'
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g allow-passthrough on
set -gq mouse on
TMUXCONF

# Create tmux session for TUI — spawnClaudeCodeProcess replaces the pane
# with interactive Claude Code. SSH users attach via `tmux attach -t claude`.
# -u forces UTF-8 mode regardless of locale detection.
tmux -u new-session -d -s claude 'sleep infinity'
CLAUDE_TUI_PTY=$(tmux display-message -p -t claude '#{pane_tty}')
export CLAUDE_TUI_PTY

# Start the runner — SDK spawns Claude Code with CLAUDE_TUI_PTY in env,
# tui-pty patch renders Ink to the tmux PTY. SSH users `tmux attach -t claude`.
cd /app
exec node packages/runner/dist/index.js

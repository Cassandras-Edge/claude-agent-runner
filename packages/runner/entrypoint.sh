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

# Start the runner process — in PTY mode it spawns Claude Code inside tmux,
# SSH users attach via `tmux attach -t claude`
cd /app
exec node packages/runner/dist/index.js

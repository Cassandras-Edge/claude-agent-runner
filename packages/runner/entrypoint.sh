#!/bin/bash
set -e

# Copy authorized_keys from read-only secret mount to runner's .ssh dir
if [ -f /etc/ssh/cass-authorized-keys ]; then
  cp /etc/ssh/cass-authorized-keys /home/runner/.ssh/authorized_keys
  chown runner:node /home/runner/.ssh/authorized_keys
  chmod 600 /home/runner/.ssh/authorized_keys
fi

# Start SSH server on port 22 (requires root)
/usr/sbin/sshd -e

# Drop to runner user for everything else
exec su -s /bin/bash runner -c '
  set -e
  cd /app

  # Start the runner process (connects back to orchestrator via WebSocket)
  node packages/runner/dist/index.js &
  RUNNER_PID=$!

  # Give runner a moment to initialize
  sleep 2

  # Start Claude Code in a tmux session for cass attach
  tmux new-session -d -s claude -x 200 -y 50
  tmux send-keys -t claude "claude --model ${RUNNER_MODEL:-opus}" Enter

  # Wait for the runner process — if it exits, the pod stops
  wait $RUNNER_PID
'

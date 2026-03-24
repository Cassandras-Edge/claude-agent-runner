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

# Start the runner process (connects back to orchestrator via WebSocket)
cd /app
node packages/runner/dist/index.js &
RUNNER_PID=$!

# Give runner a moment to initialize
sleep 2

# Start Claude Code in a tmux session for cass attach
# No fixed size — tmux adapts to the attaching client's terminal size
tmux new-session -d -s claude
tmux send-keys -t claude "claude --model ${RUNNER_MODEL:-opus}" Enter

# Wait for the runner process — if it exits, the pod stops
wait $RUNNER_PID

FROM node:22-alpine AS patcher

# Install bun (runs patch-all.js) and Claude Code (source for JS extraction)
ARG CLAUDE_CODE_VERSION=2.1.81
RUN apk add --no-cache bash && \
    npm install -g bun @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && \
    npm cache clean --force

# Copy patch files
COPY packages/runner/patches/lib/ /patches/lib/
COPY packages/runner/patches/scripts/ /patches/scripts/
COPY packages/runner/patches/patches/ /patches/patches/

# Patch in JS-only mode (no binary output, no codesign)
WORKDIR /patches
RUN bun run scripts/patch-all.js --js-only

FROM node:22-alpine AS builder

# node-pty requires native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy root workspace config and shared package
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/runner/package.json packages/runner/

RUN npm ci --workspace=packages/shared --workspace=packages/runner

# Build shared first, then runner
COPY packages/shared/ packages/shared/
RUN npm run build --workspace=packages/shared

COPY packages/runner/tsconfig.json packages/runner/
COPY packages/runner/src/ packages/runner/src/
RUN npm run build --workspace=packages/runner

FROM node:22-alpine

# Install git, common tools, build deps for node-pty, and SSH/tmux for cass attach
# NOTE: tmux is built from source with --enable-utf8proc to fix Unicode character
# width issues on Alpine/musl (wcwidth() returns wrong widths for block chars ▄▀█
# used in Claude Code's mascot). Alpine's stock tmux package lacks utf8proc support.
RUN apk add --no-cache git curl bash openssh-client openssh-server xclip python3 make g++ sudo musl-locales ncurses-terminfo \
    libevent-dev ncurses-dev utf8proc-dev bison && \
    wget -qO- https://github.com/tmux/tmux/releases/download/3.6a/tmux-3.6a.tar.gz | tar xz && \
    cd tmux-3.6a && \
    ./configure --prefix=/usr --enable-utf8proc && \
    make -j$(nproc) && make install && \
    cd .. && rm -rf tmux-3.6a && \
    apk add --no-cache libevent utf8proc ncurses-libs
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Install Claude Code CLI globally (required by agent SDK)
RUN npm install -g @anthropic-ai/claude-code@2.1.81 && npm cache clean --force

# Install bun runtime (needed for running patched CLI)
RUN npm install -g bun && npm cache clean --force

# Create runner user in the node group (GID 1000).
RUN adduser -S runner -G node
WORKDIR /app

# Install production deps only
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/runner/package.json packages/runner/

RUN npm ci --workspace=packages/shared --workspace=packages/runner --omit=dev && npm cache clean --force

# Patch SDK: V2's SQ constructor hard-codes several options, ignoring values
# from SDKSessionOptions. Fix includePartialMessages and settingSources.
RUN sed -i 's/includePartialMessages:!1,forkSession/includePartialMessages:Q.includePartialMessages??!1,forkSession/' \
    node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs && \
    sed -i 's/settingSources:\[\],allowedTools/settingSources:Q.settingSources??[],allowedTools/' \
    node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs && \
    sed -i 's/resumeSessionAt:void 0})/resumeSessionAt:void 0,spawnClaudeCodeProcess:Q.spawnClaudeCodeProcess})/' \
    node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/runner/dist packages/runner/dist

# Copy patched CLI from patcher stage, plus vendor binaries (ripgrep) and WASM files
# that the CLI resolves relative to itself. Without this, Grep/Glob tools fail with ENOENT.
COPY --from=patcher /patches/dist/cli-patched.js /opt/claude/cli-patched.js
RUN cp -r /usr/local/lib/node_modules/@anthropic-ai/claude-code/vendor /opt/claude/vendor && \
    cp /usr/local/lib/node_modules/@anthropic-ai/claude-code/*.wasm /opt/claude/ 2>/dev/null || true

# Patch CLI: relax --include-partial-messages to work without --print.
# The underlying stream_event yield code works in interactive mode — the
# guard is overly restrictive. Remove the `!VAR||` (--print check) from the guard.
# Uses regex to handle minified variable name changes across versions.
RUN node -e " \
  const fs = require('fs'); \
  let cli = fs.readFileSync('/opt/claude/cli-patched.js', 'utf8'); \
  const re = /if\((\w+)\)\{if\(!\w+\|\|(\w+)!==\"stream-json\"\)/; \
  const m = cli.match(re); \
  if (!m) { console.error('Pattern not found'); process.exit(1); } \
  cli = cli.replace(re, 'if(' + m[1] + '){if(' + m[2] + '!==\"stream-json\")'); \
  fs.writeFileSync('/opt/claude/cli-patched.js', cli); \
  console.log('Patched: removed --print requirement for --include-partial-messages'); \
"

# Workspace directory where repos get cloned or dirs get mounted
RUN mkdir -p /workspace && chown runner:node /workspace

# Claude Code expects these directories/files to exist
RUN mkdir -p /home/runner/.claude/debug /home/runner/.claude/plugins && \
    chown -R runner:node /home/runner/.claude
RUN mkdir -p /etc/claude-code && echo '{}' > /etc/claude-code/managed-settings.json

# Set patched CLI path for the runner
ENV CLAUDE_PATCHED_CLI=/opt/claude/cli-patched.js

# SSH server setup: host keys + runner user login shell
RUN ssh-keygen -A && \
    mkdir -p /home/runner/.ssh && \
    chown runner:node /home/runner/.ssh && \
    chmod 700 /home/runner/.ssh && \
    passwd -u runner 2>/dev/null || true && \
    sed -i 's/^runner:.*/runner:x:100:1000:Linux User,,,:\/home\/runner:\/bin\/bash/' /etc/passwd

# Authorized keys are injected at runtime via k8s Secret mount at /home/runner/.ssh/authorized_keys
# SSH config: allow pubkey auth, disable password auth
RUN echo -e "PermitRootLogin no\nPasswordAuthentication no\nPubkeyAuthentication yes\nAllowUsers runner" \
    >> /etc/ssh/sshd_config

# Passwordless sudo for runner (needed for sshd startup and key setup)
RUN echo "runner ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers.d/runner

# Entrypoint script
COPY packages/runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER runner
ENTRYPOINT ["/entrypoint.sh"]

FROM node:22-alpine AS patcher

# Install bun (runs patch-all.js) and Claude Code (source for JS extraction)
RUN apk add --no-cache bash && \
    npm install -g bun @anthropic-ai/claude-code@2.1.63 && \
    npm cache clean --force

# Copy patch files
COPY packages/runner/patches/lib/ /patches/lib/
COPY packages/runner/patches/scripts/ /patches/scripts/
COPY packages/runner/patches/patches/ /patches/patches/

# Patch in JS-only mode (no binary output, no codesign)
WORKDIR /patches
RUN bun run scripts/patch-all.js --js-only

FROM node:22-alpine AS builder

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

# Install git and common tools for agent work
RUN apk add --no-cache git curl bash openssh-client

# Install Claude Code CLI globally (required by agent SDK)
RUN npm install -g @anthropic-ai/claude-code@2.1.63 && npm cache clean --force

# Install bun runtime (needed for running patched CLI)
RUN npm install -g bun && npm cache clean --force

RUN addgroup -S runner && adduser -S runner -G runner
WORKDIR /app

# Install production deps only
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/runner/package.json packages/runner/

RUN npm ci --workspace=packages/shared --workspace=packages/runner --omit=dev && npm cache clean --force

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/runner/dist packages/runner/dist

# Copy patched CLI from patcher stage
COPY --from=patcher /patches/dist/cli-patched.js /opt/claude/cli-patched.js

# Workspace directory where repos get cloned or dirs get mounted
RUN mkdir -p /workspace && chown runner:runner /workspace

# Claude Code expects these directories/files to exist
RUN mkdir -p /home/runner/.claude/debug /home/runner/.claude/plugins && \
    chown -R runner:runner /home/runner/.claude
RUN mkdir -p /etc/claude-code && echo '{}' > /etc/claude-code/managed-settings.json

# Set patched CLI path for the runner
ENV CLAUDE_PATCHED_CLI=/opt/claude/cli-patched.js

USER runner
CMD ["node", "packages/runner/dist/index.js"]

FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

# Install git and common tools for agent work
RUN apk add --no-cache git curl bash openssh-client

# Install Claude Code CLI globally (required by agent SDK)
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

RUN addgroup -S runner && adduser -S runner -G runner
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Workspace directory where repos get cloned or dirs get mounted
RUN mkdir -p /workspace && chown runner:runner /workspace

USER runner
CMD ["node", "dist/index.js"]

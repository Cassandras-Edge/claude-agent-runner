FROM node:22-alpine AS builder

WORKDIR /app

# Copy root workspace config and shared package
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/orchestrator/package.json packages/orchestrator/

RUN npm ci --workspace=packages/shared --workspace=packages/orchestrator

# Build shared first, then orchestrator
COPY packages/shared/ packages/shared/
RUN npm run build --workspace=packages/shared

COPY packages/orchestrator/tsconfig.json packages/orchestrator/
COPY packages/orchestrator/src/ packages/orchestrator/src/
RUN npm run build --workspace=packages/orchestrator

FROM node:22-alpine

WORKDIR /app

# Install production deps only
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/orchestrator/package.json packages/orchestrator/

RUN npm ci --workspace=packages/shared --workspace=packages/orchestrator --omit=dev && npm cache clean --force

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/orchestrator/dist packages/orchestrator/dist

# Data directory for SQLite persistence (mount a volume here)
RUN mkdir -p /app/data

EXPOSE 8080 8081
CMD ["node", "packages/orchestrator/dist/index.js"]

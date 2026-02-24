FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Data directory for SQLite persistence (mount a volume here)
RUN mkdir -p /app/data

EXPOSE 8080 8081
CMD ["node", "dist/index.js"]

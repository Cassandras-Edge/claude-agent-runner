# @bugcat/claude-agent-runner-shared

Canonical REST and WebSocket protocol types for `claude-agent-runner`.

## What lives here

- REST DTOs shared by the orchestrator and clients
- Runner <-> orchestrator WebSocket messages
- Client <-> orchestrator WebSocket frames
- Common transport payloads like content blocks, usage, snapshots, and tenant DTOs

## Publishing

From the `claude-agent-runner` repo root:

```bash
npm run build --workspace @bugcat/claude-agent-runner-shared
npm publish --workspace @bugcat/claude-agent-runner-shared
```

The package is configured with `prepublishOnly`, so `npm publish` also rebuilds and typechecks the package before release.

## Consuming From cassandra-obsidian

Temporary local development:

```bash
npm install ../claude-agent-runner/packages/shared
```

Published dependency:

```bash
npm install @bugcat/claude-agent-runner-shared@^1.0.0
```

After publishing, replace the local `file:` dependency in `cassandra-obsidian/package.json` with the published semver range.

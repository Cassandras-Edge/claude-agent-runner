import Docker from "dockerode";
import type { Session } from "./types.js";
import { logger } from "./logger.js";

const FORWARDED_RUNNER_ENV_KEYS = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GIT_TOKEN",
  "GITHUB_TOKEN",
]);

export interface SpawnConfig {
  sessionId: string;
  image: string;
  orchestratorUrl: string;
  env: Record<string, string>;
  network: string;
  sessionsVolume?: string;
  repo?: string;
  branch?: string;
  workspace?: string;
  vault?: string;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  thinking?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  compactInstructions?: string;
  permissionMode?: string;
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  allowedPaths?: string[];
  forkFrom?: string;
  forkAt?: string;
  forkSession?: boolean;
}

export interface VaultSidecarConfig {
  sessionId: string;
  vaultName: string;
  image: string;
  network: string;
  obsidianAuthToken: string;
  e2eePassword?: string;
}

export class DockerManager {
  private docker: Docker;
  private containers = new Map<string, string>(); // sessionId -> containerId
  private sidecars = new Map<string, string>(); // sessionId -> sidecar containerId

  constructor() {
    this.docker = new Docker({ socketPath: "/var/run/docker.sock" });
  }

  async checkConnection(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async spawn(config: SpawnConfig): Promise<string> {
    const forwardedEnvEntries = Object.entries(config.env).filter(
      ([key, value]) => FORWARDED_RUNNER_ENV_KEYS.has(key) && value !== undefined && value !== "",
    );
    const forwardedEnv = Object.fromEntries(forwardedEnvEntries) as Record<string, string>;
    if (!forwardedEnv.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error("CLAUDE_CODE_OAUTH_TOKEN missing from runner environment");
    }

    logger.info("orchestrator.docker", "starting_container", {
      session_id: config.sessionId,
      image: config.image,
      network: config.network,
      has_repo: !!config.repo,
      has_workspace: !!config.workspace,
      has_fork_from: !!config.forkFrom,
    });

    const envVars = [
      `RUNNER_SESSION_ID=${config.sessionId}`,
      `RUNNER_ORCHESTRATOR_URL=${config.orchestratorUrl}`,
      ...forwardedEnvEntries.map(([k, v]) => `${k}=${v}`),
    ];

    if (config.repo) envVars.push(`RUNNER_REPO=${config.repo}`);
    if (config.branch) envVars.push(`RUNNER_BRANCH=${config.branch}`);
    if (config.model) envVars.push(`RUNNER_MODEL=${config.model}`);
    if (config.systemPrompt) envVars.push(`RUNNER_SYSTEM_PROMPT=${config.systemPrompt}`);
    if (config.maxTurns) envVars.push(`RUNNER_MAX_TURNS=${config.maxTurns}`);
    if (config.appendSystemPrompt) envVars.push(`RUNNER_APPEND_SYSTEM_PROMPT=${config.appendSystemPrompt}`);
    if (config.thinking) envVars.push(`RUNNER_THINKING=true`);
    if (config.allowedTools?.length) {
      envVars.push(`RUNNER_ALLOWED_TOOLS=${JSON.stringify(config.allowedTools)}`);
    }
    if (config.disallowedTools?.length) {
      envVars.push(`RUNNER_DISALLOWED_TOOLS=${JSON.stringify(config.disallowedTools)}`);
    }
    if (config.additionalDirectories?.length) {
      envVars.push(`RUNNER_ADDITIONAL_DIRECTORIES=${JSON.stringify(config.additionalDirectories)}`);
    }
    if (config.compactInstructions) envVars.push(`RUNNER_COMPACT_INSTRUCTIONS=${config.compactInstructions}`);
    if (config.permissionMode) envVars.push(`RUNNER_PERMISSION_MODE=${config.permissionMode}`);
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      envVars.push(`RUNNER_MCP_SERVERS=${JSON.stringify(config.mcpServers)}`);
    }
    if (config.allowedPaths?.length) {
      envVars.push(`RUNNER_ALLOWED_PATHS=${JSON.stringify(config.allowedPaths)}`);
    }
    if (config.forkFrom) envVars.push(`RUNNER_FORK_FROM=${config.forkFrom}`);
    if (config.forkAt) envVars.push(`RUNNER_FORK_AT=${config.forkAt}`);
    if (config.forkSession) envVars.push(`RUNNER_FORK_SESSION=true`);

    // Git token from env
    const gitToken = forwardedEnv.GIT_TOKEN || forwardedEnv.GITHUB_TOKEN;
    if (gitToken) envVars.push(`RUNNER_GIT_TOKEN=${gitToken}`);

    const binds: string[] = [];
    // Mount shared sessions volume so JSONL transcripts persist across container restarts
    if (config.sessionsVolume) {
      binds.push(`${config.sessionsVolume}:/home/runner/.claude`);
    }
    // Vault sessions mount the vault volume at /workspace (managed by sidecar)
    if (config.vault) {
      binds.push(`vault-${config.sessionId}:/workspace`);
    } else if (config.workspace) {
      binds.push(`${config.workspace}:/workspace`);
    }
    if (config.additionalDirectories) {
      for (const dir of config.additionalDirectories) {
        binds.push(`${dir}:${dir}:ro`);
      }
    }

    try {
      const container = await this.docker.createContainer({
        Image: config.image,
        Env: envVars,
        HostConfig: {
          Binds: binds.length > 0 ? binds : undefined,
          NetworkMode: config.network,
        },
        Labels: {
          "claude-orchestrator": "true",
          "session-id": config.sessionId,
        },
      });

      await container.start();
      const containerId = container.id;
      this.containers.set(config.sessionId, containerId);
      logger.info("orchestrator.docker", "container_started", {
        session_id: config.sessionId,
        container_id: containerId,
        binds,
      });
      return containerId;
    } catch (err: unknown) {
      logger.error("orchestrator.docker", "failed_to_start_container", {
        session_id: config.sessionId,
        image: config.image,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Spawn a vault sync sidecar container for the given session.
   * Creates a named Docker volume and starts `ob sync --continuous` inside it.
   */
  async spawnVaultSidecar(config: VaultSidecarConfig): Promise<string> {
    const volumeName = `vault-${config.sessionId}`;
    logger.info("orchestrator.docker", "spawning_vault_sidecar", {
      session_id: config.sessionId,
      vault_name: config.vaultName,
      volume: volumeName,
    });

    // Ensure the named volume exists (createVolume is idempotent if name matches)
    try {
      await this.docker.createVolume({ Name: volumeName });
    } catch (err: any) {
      // Volume may already exist — that's fine (fast re-sync)
      if (!err.message?.includes("already exists")) throw err;
    }

    const container = await this.docker.createContainer({
      Image: config.image,
      Env: [
        `OBSIDIAN_AUTH_TOKEN=${config.obsidianAuthToken}`,
        `VAULT_NAME=${config.vaultName}`,
        `VAULT_E2EE_PASSWORD=${config.e2eePassword || ""}`,
        `SESSION_ID=${config.sessionId}`,
      ],
      Cmd: ["sh", "-c", [
        `ob sync-setup --vault "$VAULT_NAME" --path /vault --password "$VAULT_E2EE_PASSWORD" --device-name "runner-${config.sessionId}"`,
        "&&",
        `ob sync --continuous --path /vault`,
      ].join(" ")],
      HostConfig: {
        Binds: [`${volumeName}:/vault`],
        NetworkMode: config.network,
      },
      Labels: {
        "claude-orchestrator": "true",
        "session-id": config.sessionId,
        "role": "vault-sync",
      },
    });

    await container.start();
    const containerId = container.id;
    this.sidecars.set(config.sessionId, containerId);

    logger.info("orchestrator.docker", "vault_sidecar_started", {
      session_id: config.sessionId,
      container_id: containerId,
      volume: volumeName,
    });
    return containerId;
  }

  /**
   * Wait for the vault sidecar to complete initial sync.
   * Polls by exec'ing `ob sync-status` inside the sidecar container.
   */
  async waitForVaultSync(sessionId: string, timeoutMs = 120_000): Promise<void> {
    const containerId = this.sidecars.get(sessionId);
    if (!containerId) throw new Error(`No vault sidecar for session ${sessionId}`);

    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 2_000;

    logger.info("orchestrator.docker", "waiting_for_vault_sync", {
      session_id: sessionId,
      timeout_ms: timeoutMs,
    });

    while (Date.now() < deadline) {
      try {
        const container = this.docker.getContainer(containerId);
        const exec = await container.exec({
          Cmd: ["ob", "sync-status", "--path", "/vault"],
          AttachStdout: true,
          AttachStderr: true,
        });
        const stream = await exec.start({ Detach: false });

        const output = await new Promise<string>((resolve) => {
          let buf = "";
          stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
          stream.on("end", () => resolve(buf));
          // Safety timeout for the exec itself
          setTimeout(() => resolve(buf), 10_000);
        });

        // "synced" or "up to date" in output means initial sync is done
        if (/synced|up.to.date/i.test(output)) {
          logger.info("orchestrator.docker", "vault_sync_complete", { session_id: sessionId });
          return;
        }
      } catch (err: any) {
        // Container might not be ready yet or exec failed — keep polling
        logger.debug("orchestrator.docker", "vault_sync_poll_error", {
          session_id: sessionId,
          error: err?.message || String(err),
        });
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    logger.warn("orchestrator.docker", "vault_sync_timeout", { session_id: sessionId, timeout_ms: timeoutMs });
    throw new Error(`Vault sync timed out after ${timeoutMs}ms for session ${sessionId}`);
  }

  async killSidecar(sessionId: string): Promise<void> {
    const containerId = this.sidecars.get(sessionId);
    if (!containerId) return;

    logger.info("orchestrator.docker", "stopping_vault_sidecar", { session_id: sessionId, container_id: containerId });
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 5 });
      await container.remove({ force: true });
    } catch (err: any) {
      if (err.statusCode !== 304 && err.statusCode !== 404) {
        logger.error("orchestrator.docker", "failed_to_stop_sidecar", {
          session_id: sessionId,
          container_id: containerId,
          error: err?.message || String(err),
        });
      }
    }
    this.sidecars.delete(sessionId);
  }

  async kill(sessionId: string): Promise<void> {
    // Kill vault sidecar first (if any)
    await this.killSidecar(sessionId);

    const containerId = this.containers.get(sessionId);
    if (!containerId) {
      logger.debug("orchestrator.docker", "kill_requested_without_container", { session_id: sessionId });
      return;
    }

    logger.warn("orchestrator.docker", "stopping_container", { session_id: sessionId, container_id: containerId });
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 5 });
      await container.remove({ force: true });
      logger.info("orchestrator.docker", "container_stopped", {
        session_id: sessionId,
        container_id: containerId,
      });
    } catch (err: any) {
      // Container may already be stopped
      if (err.statusCode !== 304 && err.statusCode !== 404) {
        logger.error("orchestrator.docker", "failed_to_stop_container", {
          session_id: sessionId,
          container_id: containerId,
          status_code: err?.statusCode,
          error: err?.message || String(err),
        });
      } else {
        logger.debug("orchestrator.docker", "container_already_stopped", { session_id: sessionId, container_id: containerId });
      }
    }

    this.containers.delete(sessionId);
  }

  async cleanup(): Promise<void> {
    logger.warn("orchestrator.docker", "cleanup_start", {
      session_count: this.containers.size,
      sidecar_count: this.sidecars.size,
    });
    const promises = Array.from(this.containers.keys()).map((sessionId) => this.kill(sessionId));
    await Promise.allSettled(promises);
  }

  /** Remove a vault volume. Use after session cleanup when volume retention is not desired. */
  async removeVaultVolume(sessionId: string): Promise<void> {
    const volumeName = `vault-${sessionId}`;
    try {
      const volume = this.docker.getVolume(volumeName);
      await volume.remove();
      logger.info("orchestrator.docker", "vault_volume_removed", { session_id: sessionId, volume: volumeName });
    } catch (err: any) {
      if (err.statusCode !== 404) {
        logger.error("orchestrator.docker", "failed_to_remove_vault_volume", {
          session_id: sessionId,
          volume: volumeName,
          error: err?.message || String(err),
        });
      }
    }
  }

  /** List all vault volumes managed by this orchestrator. */
  async listVaultVolumes(): Promise<Array<{ name: string; sessionId: string; createdAt: string }>> {
    const result = await this.docker.listVolumes({
      filters: { name: ["vault-"] },
    });
    return (result.Volumes || [])
      .filter((v) => v.Name.startsWith("vault-"))
      .map((v) => ({
        name: v.Name,
        sessionId: v.Name.replace("vault-", ""),
        createdAt: (v as any).CreatedAt || "",
      }));
  }

  hasSidecar(sessionId: string): boolean {
    return this.sidecars.has(sessionId);
  }

  async ensureNetwork(name: string): Promise<void> {
    try {
      const network = this.docker.getNetwork(name);
      await network.inspect();
    } catch {
      logger.warn("orchestrator.docker", "creating_network", { network: name });
      await this.docker.createNetwork({ Name: name, Driver: "bridge" });
    }
  }

  /**
   * Rebuild in-memory sessionId -> containerId mappings after orchestrator restart,
   * and report which persisted sessions still have a running container.
   * Also recovers vault sidecar mappings by scanning running containers with role=vault-sync.
   */
  async recoverFromSessions(sessions: Session[]): Promise<{
    running: string[];
    notRunning: string[];
    missing: string[];
  }> {
    const running: string[] = [];
    const notRunning: string[] = [];
    const missing: string[] = [];

    this.containers.clear();
    this.sidecars.clear();
    logger.info("orchestrator.docker", "recovering_sessions", { session_count: sessions.length });

    // Recover vault sidecars by scanning running containers with our labels
    try {
      const allContainers = await this.docker.listContainers({
        filters: { label: ["claude-orchestrator=true", "role=vault-sync"] },
      });
      for (const c of allContainers) {
        const sid = c.Labels?.["session-id"];
        if (sid) {
          this.sidecars.set(sid, c.Id);
          logger.debug("orchestrator.docker", "recovered_sidecar", { session_id: sid, container_id: c.Id });
        }
      }
    } catch (err: any) {
      logger.warn("orchestrator.docker", "sidecar_recovery_failed", { error: err?.message || String(err) });
    }

    for (const session of sessions) {
      try {
        const container = this.docker.getContainer(session.containerId);
        const info = await container.inspect();
        if (info?.State?.Running) {
          this.containers.set(session.id, session.containerId);
          running.push(session.id);
        } else {
          notRunning.push(session.id);
        }
      } catch (err: any) {
        if (err?.statusCode === 404) {
          missing.push(session.id);
        } else {
          logger.error("orchestrator.docker", "recover_session_inspect_failed", {
            session_id: session.id,
            container_id: session.containerId,
            status_code: err?.statusCode,
            error: err?.message || String(err),
          });
          notRunning.push(session.id);
        }
      }
    }

    logger.info("orchestrator.docker", "recovered_sessions", {
      running_count: running.length,
      not_running_count: notRunning.length,
      missing_count: missing.length,
      sidecar_count: this.sidecars.size,
    });
    return { running, notRunning, missing };
  }

  getContainerId(sessionId: string): string | undefined {
    return this.containers.get(sessionId);
  }
}

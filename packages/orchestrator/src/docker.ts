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
  vaultsVolume?: string;
  repo?: string;
  branch?: string;
  workspace?: string;
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

export interface PersistentSidecarConfig {
  vaultName: string;
  image: string;
  network: string;
  vaultsVolume: string;
  obsidianAuthToken: string;
  e2eePassword?: string;
}

export class DockerManager {
  private docker: Docker;
  private containers = new Map<string, string>(); // sessionId -> containerId
  private persistentSidecars = new Map<string, string>(); // vaultName -> sidecar containerId

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
    // Mount shared vaults volume (ACL-gated per vault)
    if (config.vaultsVolume) {
      binds.push(`${config.vaultsVolume}:/vaults`);
    }
    if (config.workspace) {
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
   * Spawn a persistent vault sync sidecar. Syncs into /vaults/<vaultName> on the shared volume.
   * Persistent sidecars are keyed by vault name and not tied to any specific session.
   */
  async spawnPersistentSidecar(config: PersistentSidecarConfig): Promise<string> {
    // Check if a sidecar for this vault is already running
    if (this.persistentSidecars.has(config.vaultName)) {
      const existingId = this.persistentSidecars.get(config.vaultName)!;
      try {
        const existing = this.docker.getContainer(existingId);
        const info = await existing.inspect();
        if (info?.State?.Running) {
          logger.info("orchestrator.docker", "persistent_sidecar_already_running", {
            vault_name: config.vaultName,
            container_id: existingId,
          });
          return existingId;
        }
      } catch {
        // Container gone or dead — proceed to spawn a new one
      }
      this.persistentSidecars.delete(config.vaultName);
    }

    logger.info("orchestrator.docker", "spawning_persistent_sidecar", {
      vault_name: config.vaultName,
      volume: config.vaultsVolume,
    });

    // Ensure the shared vaults volume exists
    try {
      await this.docker.createVolume({ Name: config.vaultsVolume });
    } catch (err: any) {
      if (!err.message?.includes("already exists")) throw err;
    }

    const sidecarId = `vault-sidecar-${config.vaultName.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
    const container = await this.docker.createContainer({
      name: sidecarId,
      Image: config.image,
      Env: [
        `OBSIDIAN_AUTH_TOKEN=${config.obsidianAuthToken}`,
        `VAULT_NAME=${config.vaultName}`,
        `VAULT_E2EE_PASSWORD=${config.e2eePassword || ""}`,
        `SIDECAR_ID=${sidecarId}`,
      ],
      HostConfig: {
        Binds: [`${config.vaultsVolume}:/vault`],
        NetworkMode: config.network,
        RestartPolicy: { Name: "unless-stopped" },
      },
      Labels: {
        "claude-orchestrator": "true",
        "role": "vault-sync",
        "vault-name": config.vaultName,
      },
    });

    await container.start();
    const containerId = container.id;
    this.persistentSidecars.set(config.vaultName, containerId);

    logger.info("orchestrator.docker", "persistent_sidecar_started", {
      vault_name: config.vaultName,
      container_id: containerId,
      volume: config.vaultsVolume,
    });
    return containerId;
  }

  /**
   * Wait for a persistent vault sidecar to complete initial sync.
   * Polls by exec'ing `ob sync-status` inside the sidecar container.
   */
  async waitForVaultSync(vaultName: string, timeoutMs = 120_000): Promise<void> {
    const containerId = this.persistentSidecars.get(vaultName);
    if (!containerId) throw new Error(`No persistent sidecar for vault "${vaultName}"`);

    const vaultPath = `/vault/${vaultName}`;
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 2_000;

    logger.info("orchestrator.docker", "waiting_for_vault_sync", {
      vault_name: vaultName,
      timeout_ms: timeoutMs,
    });

    while (Date.now() < deadline) {
      try {
        const container = this.docker.getContainer(containerId);
        const exec = await container.exec({
          Cmd: ["ob", "sync-status", "--path", vaultPath],
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
          logger.info("orchestrator.docker", "vault_sync_complete", { vault_name: vaultName });
          return;
        }
      } catch (err: any) {
        // Container might not be ready yet or exec failed — keep polling
        logger.debug("orchestrator.docker", "vault_sync_poll_error", {
          vault_name: vaultName,
          error: err?.message || String(err),
        });
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    logger.warn("orchestrator.docker", "vault_sync_timeout", { vault_name: vaultName, timeout_ms: timeoutMs });
    throw new Error(`Vault sync timed out after ${timeoutMs}ms for vault "${vaultName}"`);
  }

  /** Stop and remove a persistent vault sidecar by vault name. */
  async killPersistentSidecar(vaultName: string): Promise<void> {
    const containerId = this.persistentSidecars.get(vaultName);
    if (!containerId) return;

    logger.info("orchestrator.docker", "stopping_persistent_sidecar", { vault_name: vaultName, container_id: containerId });
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 5 });
      await container.remove({ force: true });
    } catch (err: any) {
      if (err.statusCode !== 304 && err.statusCode !== 404) {
        logger.error("orchestrator.docker", "failed_to_stop_persistent_sidecar", {
          vault_name: vaultName,
          container_id: containerId,
          error: err?.message || String(err),
        });
      }
    }
    this.persistentSidecars.delete(vaultName);
  }

  async kill(sessionId: string): Promise<void> {
    // Note: persistent sidecars are NOT killed with sessions — they are vault-scoped
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
      sidecar_count: this.persistentSidecars.size,
    });
    const promises = Array.from(this.containers.keys()).map((sessionId) => this.kill(sessionId));
    await Promise.allSettled(promises);
  }

  /** Check if a persistent sidecar is running for a vault. */
  hasPersistentSidecar(vaultName: string): boolean {
    return this.persistentSidecars.has(vaultName);
  }

  /** List all persistent vault sidecars. */
  listPersistentSidecars(): Array<{ vaultName: string; containerId: string }> {
    return Array.from(this.persistentSidecars.entries()).map(([vaultName, containerId]) => ({
      vaultName,
      containerId,
    }));
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

  /** Ensure the shared vaults volume exists. */
  async ensureVaultsVolume(volumeName: string): Promise<void> {
    try {
      await this.docker.createVolume({ Name: volumeName });
    } catch (err: any) {
      if (!err.message?.includes("already exists")) throw err;
    }
    logger.info("orchestrator.docker", "vaults_volume_ensured", { volume: volumeName });
  }

  /**
   * Rebuild in-memory sessionId -> containerId mappings after orchestrator restart,
   * and report which persisted sessions still have a running container.
   * Also recovers persistent vault sidecar mappings by scanning running containers with role=vault-sync.
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
    this.persistentSidecars.clear();
    logger.info("orchestrator.docker", "recovering_sessions", { session_count: sessions.length });

    // Recover persistent vault sidecars by scanning running containers with our labels
    try {
      const allContainers = await this.docker.listContainers({
        filters: { label: ["claude-orchestrator=true", "role=vault-sync"] },
      });
      for (const c of allContainers) {
        const vaultName = c.Labels?.["vault-name"];
        if (vaultName) {
          this.persistentSidecars.set(vaultName, c.Id);
          logger.debug("orchestrator.docker", "recovered_persistent_sidecar", { vault_name: vaultName, container_id: c.Id });
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
      persistent_sidecar_count: this.persistentSidecars.size,
    });
    return { running, notRunning, missing };
  }

  /** Rekey a container mapping from one session ID to another (used by warm pool adoption). */
  rekeySession(oldId: string, newId: string): boolean {
    const containerId = this.containers.get(oldId);
    if (!containerId) return false;
    this.containers.delete(oldId);
    this.containers.set(newId, containerId);
    logger.info("orchestrator.docker", "rekey_session", { old_id: oldId, new_id: newId, container_id: containerId });
    return true;
  }

  getContainerId(sessionId: string): string | undefined {
    return this.containers.get(sessionId);
  }
}

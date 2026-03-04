import Docker from "dockerode";
import type { Session } from "./types.js";
import { logger } from "./logger.js";

export const FORWARDED_RUNNER_ENV_KEYS = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GIT_TOKEN",
  "GITHUB_TOKEN",
  "OBSIDIAN_AUTH_TOKEN",
  "OBSIDIAN_E2EE_PASSWORD",
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
  /** k8s namespace for the pod (used by K8sManager, ignored by DockerManager). */
  namespace?: string;
}

/** Backend-agnostic interface for container/pod lifecycle management. */
export interface ContainerManager {
  checkConnection(): Promise<boolean>;
  spawn(config: SpawnConfig): Promise<string>;
  kill(sessionId: string): Promise<void>;
  cleanup(): Promise<void>;
  recoverFromSessions(sessions: Session[]): Promise<{
    running: string[];
    notRunning: string[];
    missing: string[];
  }>;
  rekeySession(oldId: string, newId: string): boolean;
  getContainerId(sessionId: string): string | undefined;
  /** Ensure networking prerequisites. No-op for k8s. */
  ensureNetwork(name: string): Promise<void>;
}

export class DockerManager implements ContainerManager {
  private docker: Docker;
  private containers = new Map<string, string>(); // sessionId -> containerId

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
      has_vault: !!config.vault,
      has_fork_from: !!config.forkFrom,
    });

    const envVars = [
      `RUNNER_SESSION_ID=${config.sessionId}`,
      `RUNNER_ORCHESTRATOR_URL=${config.orchestratorUrl}`,
      ...forwardedEnvEntries.map(([k, v]) => `${k}=${v}`),
    ];

    if (config.repo) envVars.push(`RUNNER_REPO=${config.repo}`);
    if (config.branch) envVars.push(`RUNNER_BRANCH=${config.branch}`);
    if (config.vault) envVars.push(`RUNNER_VAULT=${config.vault}`);
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

  async kill(sessionId: string): Promise<void> {
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
    });
    const promises = Array.from(this.containers.keys()).map((sessionId) => this.kill(sessionId));
    await Promise.allSettled(promises);
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
    logger.info("orchestrator.docker", "recovering_sessions", { session_count: sessions.length });

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

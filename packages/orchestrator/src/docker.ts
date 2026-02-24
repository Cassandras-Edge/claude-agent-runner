import Docker from "dockerode";

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
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  thinking?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  compactInstructions?: string;
}

export class DockerManager {
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

    console.log(`Container ${containerId.slice(0, 12)} started for session ${config.sessionId}`);
    return containerId;
  }

  async kill(sessionId: string): Promise<void> {
    const containerId = this.containers.get(sessionId);
    if (!containerId) return;

    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 5 });
      await container.remove({ force: true });
      console.log(`Container ${containerId.slice(0, 12)} stopped for session ${sessionId}`);
    } catch (err: any) {
      // Container may already be stopped
      if (err.statusCode !== 304 && err.statusCode !== 404) {
        console.error(`Error stopping container ${containerId.slice(0, 12)}:`, err.message);
      }
    }

    this.containers.delete(sessionId);
  }

  async cleanup(): Promise<void> {
    console.log("Cleaning up all runner containers...");
    const promises = Array.from(this.containers.keys()).map((sessionId) => this.kill(sessionId));
    await Promise.allSettled(promises);
  }

  async ensureNetwork(name: string): Promise<void> {
    try {
      const network = this.docker.getNetwork(name);
      await network.inspect();
    } catch {
      console.log(`Creating Docker network: ${name}`);
      await this.docker.createNetwork({ Name: name, Driver: "bridge" });
    }
  }

  getContainerId(sessionId: string): string | undefined {
    return this.containers.get(sessionId);
  }
}

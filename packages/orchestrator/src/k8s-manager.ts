import * as k8s from "@kubernetes/client-node";
import type { Session } from "./types.js";
import type { ContainerManager, SpawnConfig } from "./docker.js";
import { FORWARDED_RUNNER_ENV_KEYS } from "./docker.js";
import { logger } from "./logger.js";

const LABEL_MANAGED = "claude-orchestrator";
const LABEL_SESSION_ID = "session-id";
const LABEL_ROLE = "role";

export interface K8sManagerConfig {
  namespace?: string;
  /** CPU request per runner pod (e.g. "500m"). */
  cpuRequest?: string;
  /** CPU limit per runner pod (e.g. "2"). */
  cpuLimit?: string;
  /** Memory request per runner pod (e.g. "512Mi"). */
  memoryRequest?: string;
  /** Memory limit per runner pod (e.g. "2Gi"). */
  memoryLimit?: string;
  /** PVC name for sessions volume (mounted as /home/runner/.claude). */
  sessionsPvcName?: string;
  /** Image pull policy for runner pods (default: unset, k8s default). */
  imagePullPolicy?: string;
}

export class K8sManager implements ContainerManager {
  private kc: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private namespace: string;
  private pods = new Map<string, string>(); // sessionId -> podName
  private podNamespaces = new Map<string, string>(); // sessionId -> namespace
  private config: K8sManagerConfig;

  constructor(config: K8sManagerConfig = {}) {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault(); // in-cluster or ~/.kube/config
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.namespace = config.namespace || process.env.K8S_NAMESPACE || "claude-runner";
    this.config = config;
  }

  async checkConnection(): Promise<boolean> {
    try {
      await this.coreApi.listNamespacedPod({
        namespace: this.namespace,
        limit: 1,
      });
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

    // Use tenant namespace if provided, otherwise default
    const targetNamespace = config.namespace || this.namespace;

    // Sanitize session ID for k8s naming (must be lowercase, alphanumeric + hyphens)
    const podName = `runner-${config.sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);

    logger.info("orchestrator.k8s", "creating_pod", {
      session_id: config.sessionId,
      pod_name: podName,
      image: config.image,
      has_repo: !!config.repo,
      has_workspace: !!config.workspace,
      has_vault: !!config.vault,
      has_fork_from: !!config.forkFrom,
    });

    const credEntries = Object.entries(config.credentialsEnv || {}).filter(
      ([, v]) => v !== undefined && v !== "",
    );

    const envVars: k8s.V1EnvVar[] = [
      { name: "RUNNER_SESSION_ID", value: config.sessionId },
      { name: "RUNNER_ORCHESTRATOR_URL", value: config.orchestratorUrl },
      ...forwardedEnvEntries.map(([k, v]) => ({ name: k, value: v })),
      ...credEntries.map(([k, v]) => ({ name: k, value: v })),
    ];

    if (config.repo) envVars.push({ name: "RUNNER_REPO", value: config.repo });
    if (config.branch) envVars.push({ name: "RUNNER_BRANCH", value: config.branch });
    if (config.vault) envVars.push({ name: "RUNNER_VAULT", value: config.vault });
    if (config.model) envVars.push({ name: "RUNNER_MODEL", value: config.model });
    if (config.systemPrompt) envVars.push({ name: "RUNNER_SYSTEM_PROMPT", value: config.systemPrompt });
    if (config.maxTurns) envVars.push({ name: "RUNNER_MAX_TURNS", value: String(config.maxTurns) });
    if (config.appendSystemPrompt) envVars.push({ name: "RUNNER_APPEND_SYSTEM_PROMPT", value: config.appendSystemPrompt });
    if (config.thinking) envVars.push({ name: "RUNNER_THINKING", value: "true" });
    if (config.allowedTools?.length) {
      envVars.push({ name: "RUNNER_ALLOWED_TOOLS", value: JSON.stringify(config.allowedTools) });
    }
    if (config.disallowedTools?.length) {
      envVars.push({ name: "RUNNER_DISALLOWED_TOOLS", value: JSON.stringify(config.disallowedTools) });
    }
    if (config.additionalDirectories?.length) {
      envVars.push({ name: "RUNNER_ADDITIONAL_DIRECTORIES", value: JSON.stringify(config.additionalDirectories) });
    }
    if (config.compactInstructions) envVars.push({ name: "RUNNER_COMPACT_INSTRUCTIONS", value: config.compactInstructions });
    if (config.permissionMode) envVars.push({ name: "RUNNER_PERMISSION_MODE", value: config.permissionMode });
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      envVars.push({ name: "RUNNER_MCP_SERVERS", value: JSON.stringify(config.mcpServers) });
    }
    if (config.allowedPaths?.length) {
      envVars.push({ name: "RUNNER_ALLOWED_PATHS", value: JSON.stringify(config.allowedPaths) });
    }
    if (config.sdkSessionId) envVars.push({ name: "RUNNER_SDK_SESSION_ID", value: config.sdkSessionId });
    if (config.forkFrom) envVars.push({ name: "RUNNER_FORK_FROM", value: config.forkFrom });
    if (config.forkAt) envVars.push({ name: "RUNNER_FORK_AT", value: config.forkAt });
    if (config.forkSession) envVars.push({ name: "RUNNER_FORK_SESSION", value: "true" });

    const gitToken = forwardedEnv.GIT_TOKEN || forwardedEnv.GITHUB_TOKEN;
    if (gitToken) envVars.push({ name: "RUNNER_GIT_TOKEN", value: gitToken });

    // Volume mounts
    const volumeMounts: k8s.V1VolumeMount[] = [];
    const volumes: k8s.V1Volume[] = [];

    // Vault: shared PVC (pre-provisioned by Helm, kept fresh by vault-sync daemon).
    if (config.vault) {
      const sanitizedVault = config.vault.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      volumes.push({ name: "vault", persistentVolumeClaim: { claimName: `vault-${sanitizedVault}` } });
      volumeMounts.push({ name: "vault", mountPath: "/workspace" });
    }

    // Agent PVC: per-agent Claude config (memory, transcripts) — replaces shared sessions PVC.
    if (config.agentId) {
      const sanitizedAgent = config.agentId.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      const agentPvcName = `agent-${sanitizedAgent}`;
      await this.ensurePvc(agentPvcName, targetNamespace, "agent-config");
      volumes.push({ name: "agent-config", persistentVolumeClaim: { claimName: agentPvcName } });
      volumeMounts.push({ name: "agent-config", mountPath: "/home/runner/.claude" });
    } else {
      const sessionsPvc = this.config.sessionsPvcName || config.sessionsVolume;
      if (sessionsPvc) {
        volumes.push({
          name: "sessions",
          persistentVolumeClaim: { claimName: sessionsPvc },
        });
        volumeMounts.push({
          name: "sessions",
          mountPath: "/home/runner/.claude",
        });
      }
    }

    // Workspace: in k8s, workspace is typically a PVC or emptyDir.
    // For host-path workspaces (dev mode), we skip — not supported in multi-node k8s.
    // The runner clones repos itself, so workspace mounts are usually not needed.

    const podSpec: k8s.V1Pod = {
      metadata: {
        name: podName,
        namespace: targetNamespace,
        labels: {
          [LABEL_MANAGED]: "true",
          [LABEL_SESSION_ID]: config.sessionId,
          [LABEL_ROLE]: "session",
        },
      },
      spec: {
        restartPolicy: "Never",
        containers: [
          {
            name: "runner",
            image: config.image,
            imagePullPolicy: this.config.imagePullPolicy as any || undefined,
            env: envVars,
            volumeMounts: volumeMounts.length > 0 ? volumeMounts : undefined,
            resources: {
              requests: {
                ...(this.config.cpuRequest ? { cpu: this.config.cpuRequest } : {}),
                ...(this.config.memoryRequest ? { memory: this.config.memoryRequest } : {}),
              },
              limits: {
                ...(this.config.cpuLimit ? { cpu: this.config.cpuLimit } : {}),
                ...(this.config.memoryLimit ? { memory: this.config.memoryLimit } : {}),
              },
            },
          },
        ],
        volumes: volumes.length > 0 ? volumes : undefined,
      },
    };

    try {
      const result = await this.coreApi.createNamespacedPod({
        namespace: targetNamespace,
        body: podSpec,
      });
      const createdPodName = result.metadata?.name || podName;
      this.pods.set(config.sessionId, createdPodName);
      this.podNamespaces.set(config.sessionId, targetNamespace);

      logger.info("orchestrator.k8s", "pod_created", {
        session_id: config.sessionId,
        pod_name: createdPodName,
      });
      return createdPodName;
    } catch (err: unknown) {
      logger.error("orchestrator.k8s", "failed_to_create_pod", {
        session_id: config.sessionId,
        pod_name: podName,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async kill(sessionId: string): Promise<void> {
    const podName = this.pods.get(sessionId);
    if (!podName) {
      logger.debug("orchestrator.k8s", "kill_requested_without_pod", { session_id: sessionId });
      return;
    }

    const ns = this.podNamespaces.get(sessionId) || this.namespace;
    logger.warn("orchestrator.k8s", "deleting_pod", { session_id: sessionId, pod_name: podName, namespace: ns });
    try {
      await this.coreApi.deleteNamespacedPod({
        name: podName,
        namespace: ns,
        gracePeriodSeconds: 5,
      });
      logger.info("orchestrator.k8s", "pod_deleted", {
        session_id: sessionId,
        pod_name: podName,
      });
    } catch (err: any) {
      if (err?.body?.code !== 404 && err?.statusCode !== 404) {
        logger.error("orchestrator.k8s", "failed_to_delete_pod", {
          session_id: sessionId,
          pod_name: podName,
          error: err?.message || String(err),
        });
      } else {
        logger.debug("orchestrator.k8s", "pod_already_deleted", { session_id: sessionId, pod_name: podName });
      }
    }

    this.pods.delete(sessionId);
    this.podNamespaces.delete(sessionId);
  }

  async cleanup(): Promise<void> {
    logger.warn("orchestrator.k8s", "cleanup_start", {
      session_count: this.pods.size,
    });
    const promises = Array.from(this.pods.keys()).map((sessionId) => this.kill(sessionId));
    await Promise.allSettled(promises);
  }

  /** No-op for k8s — flat networking within namespace. */
  async ensureNetwork(_name: string): Promise<void> {
    // k8s pods share flat network within namespace, no setup needed
  }

  async recoverFromSessions(sessions: Session[]): Promise<{
    running: string[];
    notRunning: string[];
    missing: string[];
  }> {
    const running: string[] = [];
    const notRunning: string[] = [];
    const missing: string[] = [];

    this.pods.clear();
    this.podNamespaces.clear();
    logger.info("orchestrator.k8s", "recovering_sessions", { session_count: sessions.length });

    // In multi-tenant mode, pods may be in different namespaces.
    // We use listPodForAllNamespaces with label selector to find all managed pods.
    let managedPods: k8s.V1Pod[] = [];
    try {
      const podList = await this.coreApi.listPodForAllNamespaces({
        labelSelector: `${LABEL_MANAGED}=true`,
      });
      managedPods = podList.items || [];
    } catch (err) {
      // Fallback to default namespace only
      logger.warn("orchestrator.k8s", "failed_to_list_all_namespaces_falling_back", {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        const podList = await this.coreApi.listNamespacedPod({
          namespace: this.namespace,
          labelSelector: `${LABEL_MANAGED}=true`,
        });
        managedPods = podList.items || [];
      } catch (err2) {
        logger.error("orchestrator.k8s", "failed_to_list_pods", {
          error: err2 instanceof Error ? err2.message : String(err2),
        });
      }
    }

    // Build a map of sessionId -> pod for quick lookup
    const podBySession = new Map<string, k8s.V1Pod>();
    for (const pod of managedPods) {
      const sid = pod.metadata?.labels?.[LABEL_SESSION_ID];
      if (sid) podBySession.set(sid, pod);
    }

    for (const session of sessions) {
      const pod = podBySession.get(session.id);
      if (!pod) {
        missing.push(session.id);
        continue;
      }

      const podName = pod.metadata?.name;
      const podNs = pod.metadata?.namespace || this.namespace;
      const phase = pod.status?.phase;
      if (phase === "Running" && podName) {
        this.pods.set(session.id, podName);
        this.podNamespaces.set(session.id, podNs);
        running.push(session.id);
      } else {
        notRunning.push(session.id);
      }
    }

    logger.info("orchestrator.k8s", "recovered_sessions", {
      running_count: running.length,
      not_running_count: notRunning.length,
      missing_count: missing.length,
    });
    return { running, notRunning, missing };
  }

  rekeySession(oldId: string, newId: string): boolean {
    const podName = this.pods.get(oldId);
    if (!podName) return false;
    const ns = this.podNamespaces.get(oldId) || this.namespace;
    this.pods.delete(oldId);
    this.podNamespaces.delete(oldId);
    this.pods.set(newId, podName);
    this.podNamespaces.set(newId, ns);

    // Also patch the pod label asynchronously
    this.patchPodLabel(podName, newId, ns).catch((err) => {
      logger.error("orchestrator.k8s", "rekey_label_patch_failed", {
        old_id: oldId,
        new_id: newId,
        pod_name: podName,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info("orchestrator.k8s", "rekey_session", { old_id: oldId, new_id: newId, pod_name: podName });
    return true;
  }

  getContainerId(sessionId: string): string | undefined {
    return this.pods.get(sessionId);
  }

  private async ensurePvc(name: string, namespace: string, role: string): Promise<void> {
    try {
      await this.coreApi.readNamespacedPersistentVolumeClaim({ name, namespace });
      logger.debug("orchestrator.k8s", "pvc_exists", { name, namespace, role });
    } catch {
      logger.info("orchestrator.k8s", "creating_pvc", { name, namespace, role });
      await this.coreApi.createNamespacedPersistentVolumeClaim({
        namespace,
        body: {
          metadata: {
            name,
            namespace,
            labels: {
              [LABEL_MANAGED]: "true",
              role,
            },
          },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: {
              requests: { storage: "10Gi" },
            },
          },
        },
      });
    }
  }

  private async patchPodLabel(podName: string, newSessionId: string, namespace?: string): Promise<void> {
    await this.coreApi.patchNamespacedPod({
      name: podName,
      namespace: namespace || this.namespace,
      body: {
        metadata: {
          labels: {
            [LABEL_SESSION_ID]: newSessionId,
            [LABEL_ROLE]: "session",
          },
        },
      },
    });
  }
}

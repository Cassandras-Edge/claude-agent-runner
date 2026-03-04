import * as k8s from "@kubernetes/client-node";
import type { Tenant } from "./tenants.js";
import { logger } from "./logger.js";

const LABEL_TENANT = "claude-tenant";

export class K8sProvisioner {
  private kc: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private sessionsPvcSize: string;

  constructor(sessionsPvcSize?: string) {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.sessionsPvcSize = sessionsPvcSize || "10Gi";
  }

  /** Create namespace, PVC, and secrets for a new tenant. */
  async provision(tenant: Tenant): Promise<void> {
    const ns = tenant.namespace;
    logger.info("orchestrator.k8s_provisioner", "provisioning", { tenant_id: tenant.id, namespace: ns });

    // 1. Create namespace
    await this.coreApi.createNamespace({
      body: {
        metadata: {
          name: ns,
          labels: {
            [LABEL_TENANT]: tenant.id,
          },
        },
      },
    });

    // 2. Create sessions PVC
    await this.coreApi.createNamespacedPersistentVolumeClaim({
      namespace: ns,
      body: {
        metadata: { name: "sessions" },
        spec: {
          accessModes: ["ReadWriteMany"],
          resources: {
            requests: { storage: this.sessionsPvcSize },
          },
        },
      },
    });

    // 3. Create tenant-config secret with Obsidian/git tokens
    const secretData: Record<string, string> = {};
    if (tenant.obsidianAuthToken) secretData.OBSIDIAN_AUTH_TOKEN = tenant.obsidianAuthToken;
    if (tenant.obsidianE2eePassword) secretData.OBSIDIAN_E2EE_PASSWORD = tenant.obsidianE2eePassword;
    if (tenant.gitToken) {
      secretData.GIT_TOKEN = tenant.gitToken;
      secretData.GITHUB_TOKEN = tenant.gitToken;
    }

    if (Object.keys(secretData).length > 0) {
      await this.coreApi.createNamespacedSecret({
        namespace: ns,
        body: {
          metadata: { name: "tenant-config" },
          type: "Opaque",
          stringData: secretData,
        },
      });
    }

    logger.info("orchestrator.k8s_provisioner", "provisioned", {
      tenant_id: tenant.id,
      namespace: ns,
      has_secret: Object.keys(secretData).length > 0,
    });
  }

  /** Delete a tenant's namespace (cascades all resources). */
  async deprovision(namespace: string): Promise<void> {
    logger.warn("orchestrator.k8s_provisioner", "deprovisioning", { namespace });
    try {
      await this.coreApi.deleteNamespace({ name: namespace });
      logger.info("orchestrator.k8s_provisioner", "deprovisioned", { namespace });
    } catch (err: any) {
      if (err?.body?.code !== 404 && err?.statusCode !== 404) {
        logger.error("orchestrator.k8s_provisioner", "deprovision_failed", {
          namespace,
          error: err?.message || String(err),
        });
        throw err;
      }
      logger.debug("orchestrator.k8s_provisioner", "namespace_already_deleted", { namespace });
    }
  }

  /** Update tenant-config secret (e.g. after Obsidian token change). */
  async updateSecret(namespace: string, tenant: Tenant): Promise<void> {
    const secretData: Record<string, string> = {};
    if (tenant.obsidianAuthToken) secretData.OBSIDIAN_AUTH_TOKEN = tenant.obsidianAuthToken;
    if (tenant.obsidianE2eePassword) secretData.OBSIDIAN_E2EE_PASSWORD = tenant.obsidianE2eePassword;
    if (tenant.gitToken) {
      secretData.GIT_TOKEN = tenant.gitToken;
      secretData.GITHUB_TOKEN = tenant.gitToken;
    }

    try {
      await this.coreApi.patchNamespacedSecret({
        name: "tenant-config",
        namespace,
        body: {
          stringData: secretData,
        },
      });
    } catch (err: any) {
      if (err?.body?.code === 404 || err?.statusCode === 404) {
        // Secret doesn't exist yet — create it
        if (Object.keys(secretData).length > 0) {
          await this.coreApi.createNamespacedSecret({
            namespace,
            body: {
              metadata: { name: "tenant-config" },
              type: "Opaque",
              stringData: secretData,
            },
          });
        }
      } else {
        throw err;
      }
    }
  }
}

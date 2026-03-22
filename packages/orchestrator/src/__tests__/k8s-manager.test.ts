import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SpawnConfig } from "../docker.js";

// Mock @kubernetes/client-node before importing K8sManager
const mockCoreApi = {
  listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
  createNamespacedPod: vi.fn().mockResolvedValue({
    metadata: { name: "runner-session-1" },
  }),
  readNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue(new Error("not found")),
  createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue(undefined),
  deleteNamespacedPod: vi.fn().mockResolvedValue(undefined),
  patchNamespacedPod: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    loadFromDefault() {}
    makeApiClient() {
      return mockCoreApi;
    }
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: class {},
  };
});

const { K8sManager } = await import("../k8s-manager.js");

describe("K8sManager", () => {
  let manager: InstanceType<typeof K8sManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new K8sManager({ namespace: "test-ns" });
  });

  describe("checkConnection", () => {
    it("returns true when k8s API is reachable", async () => {
      expect(await manager.checkConnection()).toBe(true);
    });

    it("returns false when k8s API call fails", async () => {
      mockCoreApi.listNamespacedPod.mockRejectedValueOnce(new Error("connection refused"));
      expect(await manager.checkConnection()).toBe(false);
    });
  });

  describe("spawn", () => {
    const baseConfig: SpawnConfig = {
      sessionId: "session-1",
      image: "claude-runner:latest",
      orchestratorUrl: "ws://claude-orchestrator:8081",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
      network: "claude-net", // ignored in k8s
    };

    it("returns the pod name", async () => {
      const podName = await manager.spawn(baseConfig);
      expect(podName).toBe("runner-session-1");
    });



    it("stores the pod name for later retrieval", async () => {
      await manager.spawn(baseConfig);
      expect(manager.getContainerId("session-1")).toBe("runner-session-1");
    });

    it("creates pod with correct labels", async () => {
      await manager.spawn(baseConfig);

      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "test-ns",
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              labels: expect.objectContaining({
                "claude-orchestrator": "true",
                "session-id": "session-1",
                role: "session",
              }),
            }),
          }),
        }),
      );
    });

    it("sets RUNNER_SESSION_ID and RUNNER_ORCHESTRATOR_URL env vars", async () => {
      await manager.spawn(baseConfig);

      const call = mockCoreApi.createNamespacedPod.mock.calls[0][0];
      const envVars = call.body.spec.containers[0].env;
      expect(envVars).toEqual(
        expect.arrayContaining([
          { name: "RUNNER_SESSION_ID", value: "session-1" },
          { name: "RUNNER_ORCHESTRATOR_URL", value: "ws://claude-orchestrator:8081" },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "test-token" },
        ]),
      );
    });

    it("sets optional env vars when config provides them", async () => {
      await manager.spawn({
        ...baseConfig,
        repo: "https://github.com/test/repo",
        vault: "my-vault",
        model: "opus",
        thinking: true,
      });

      const call = mockCoreApi.createNamespacedPod.mock.calls[0][0];
      const envVars = call.body.spec.containers[0].env;
      expect(envVars).toEqual(
        expect.arrayContaining([
          { name: "RUNNER_REPO", value: "https://github.com/test/repo" },
          { name: "RUNNER_VAULT", value: "my-vault" },
          { name: "RUNNER_MODEL", value: "opus" },
          { name: "RUNNER_THINKING", value: "true" },
        ]),
      );
    });

    it("mounts sessions PVC when sessionsPvcName is configured", async () => {
      const mgr = new K8sManager({ namespace: "test-ns", sessionsPvcName: "claude-sessions" });
      await mgr.spawn(baseConfig);

      const call = mockCoreApi.createNamespacedPod.mock.calls[0][0];
      const volumes = call.body.spec.volumes;
      const mounts = call.body.spec.containers[0].volumeMounts;

      expect(volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "sessions",
            persistentVolumeClaim: { claimName: "claude-sessions" },
          }),
        ]),
      );
      expect(mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "sessions",
            mountPath: "/home/runner/.claude",
          }),
        ]),
      );
    });

    it("sets resource requests/limits when configured", async () => {
      const mgr = new K8sManager({
        namespace: "test-ns",
        cpuRequest: "500m",
        cpuLimit: "2",
        memoryRequest: "512Mi",
        memoryLimit: "2Gi",
      });
      await mgr.spawn(baseConfig);

      const call = mockCoreApi.createNamespacedPod.mock.calls[0][0];
      const resources = call.body.spec.containers[0].resources;

      expect(resources.requests).toEqual({ cpu: "500m", memory: "512Mi" });
      expect(resources.limits).toEqual({ cpu: "2", memory: "2Gi" });
    });

    it("uses restartPolicy: Never", async () => {
      await manager.spawn(baseConfig);

      const call = mockCoreApi.createNamespacedPod.mock.calls[0][0];
      expect(call.body.spec.restartPolicy).toBe("Never");
    });

    it("sanitizes pod name to be k8s-compliant", async () => {
      await manager.spawn({
        ...baseConfig,
        sessionId: "Session_With.Special+Chars",
      });

      const call = mockCoreApi.createNamespacedPod.mock.calls[0][0];
      // Should be lowercase, alphanumeric + hyphens only
      expect(call.body.metadata.name).toMatch(/^[a-z0-9-]+$/);
      expect(call.body.metadata.name).toBe("runner-session-with-special-chars");
    });
  });

  describe("kill", () => {
    const baseConfig: SpawnConfig = {
      sessionId: "session-1",
      image: "claude-runner:latest",
      orchestratorUrl: "ws://claude-orchestrator:8081",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
      network: "claude-net",
    };

    it("deletes the pod and removes mapping", async () => {
      await manager.spawn(baseConfig);
      expect(manager.getContainerId("session-1")).toBe("runner-session-1");

      await manager.kill("session-1");
      expect(manager.getContainerId("session-1")).toBeUndefined();
      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "runner-session-1",
          namespace: "test-ns",
          gracePeriodSeconds: 5,
        }),
      );
    });

    it("is a no-op for unknown sessions", async () => {
      await expect(manager.kill("nonexistent")).resolves.toBeUndefined();
      expect(mockCoreApi.deleteNamespacedPod).not.toHaveBeenCalled();
    });

    it("handles 404 (already deleted) gracefully", async () => {
      await manager.spawn(baseConfig);
      mockCoreApi.deleteNamespacedPod.mockRejectedValueOnce({ body: { code: 404 } });
      await expect(manager.kill("session-1")).resolves.toBeUndefined();
      expect(manager.getContainerId("session-1")).toBeUndefined();
    });
  });

  describe("cleanup", () => {
    it("kills all tracked pods", async () => {
      const baseConfig: SpawnConfig = {
        sessionId: "s1",
        image: "claude-runner:latest",
        orchestratorUrl: "ws://claude-orchestrator:8081",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
        network: "claude-net",
      };

      mockCoreApi.createNamespacedPod
        .mockResolvedValueOnce({ metadata: { name: "runner-s1" } })
        .mockResolvedValueOnce({ metadata: { name: "runner-s2" } });

      await manager.spawn({ ...baseConfig, sessionId: "s1" });
      await manager.spawn({ ...baseConfig, sessionId: "s2" });

      await manager.cleanup();
      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledTimes(2);
    });
  });

  describe("ensureNetwork", () => {
    it("is a no-op (k8s flat networking)", async () => {
      await expect(manager.ensureNetwork("anything")).resolves.toBeUndefined();
    });
  });

  describe("recoverFromSessions", () => {
    it("classifies running pods", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValueOnce({
        items: [
          {
            metadata: { name: "runner-s1", labels: { "session-id": "s1" } },
            status: { phase: "Running" },
          },
        ],
      });

      const result = await manager.recoverFromSessions([
        { id: "s1", containerId: "runner-s1" } as any,
      ]);

      expect(result.running).toEqual(["s1"]);
      expect(result.notRunning).toEqual([]);
      expect(result.missing).toEqual([]);
      expect(manager.getContainerId("s1")).toBe("runner-s1");
    });

    it("classifies non-running pods", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValueOnce({
        items: [
          {
            metadata: { name: "runner-s1", labels: { "session-id": "s1" } },
            status: { phase: "Succeeded" },
          },
        ],
      });

      const result = await manager.recoverFromSessions([
        { id: "s1", containerId: "runner-s1" } as any,
      ]);

      expect(result.running).toEqual([]);
      expect(result.notRunning).toEqual(["s1"]);
      expect(result.missing).toEqual([]);
    });

    it("classifies missing pods", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValueOnce({ items: [] });

      const result = await manager.recoverFromSessions([
        { id: "s1", containerId: "runner-s1" } as any,
      ]);

      expect(result.running).toEqual([]);
      expect(result.notRunning).toEqual([]);
      expect(result.missing).toEqual(["s1"]);
    });

    it("handles multiple sessions at once", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValueOnce({
        items: [
          {
            metadata: { name: "runner-s1", labels: { "session-id": "s1" } },
            status: { phase: "Running" },
          },
          {
            metadata: { name: "runner-s2", labels: { "session-id": "s2" } },
            status: { phase: "Failed" },
          },
        ],
      });

      const result = await manager.recoverFromSessions([
        { id: "s1", containerId: "runner-s1" } as any,
        { id: "s2", containerId: "runner-s2" } as any,
        { id: "s3", containerId: "runner-s3" } as any,
      ]);

      expect(result.running).toEqual(["s1"]);
      expect(result.notRunning).toEqual(["s2"]);
      expect(result.missing).toEqual(["s3"]);
    });
  });

  describe("rekeySession", () => {
    const baseConfig: SpawnConfig = {
      sessionId: "old-id",
      image: "claude-runner:latest",
      orchestratorUrl: "ws://claude-orchestrator:8081",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
      network: "claude-net",
    };

    it("updates the in-memory mapping", async () => {
      mockCoreApi.createNamespacedPod.mockResolvedValueOnce({ metadata: { name: "runner-old-id" } });
      await manager.spawn(baseConfig);

      const result = manager.rekeySession("old-id", "new-id");
      expect(result).toBe(true);
      expect(manager.getContainerId("old-id")).toBeUndefined();
      expect(manager.getContainerId("new-id")).toBe("runner-old-id");
    });

    it("patches pod labels asynchronously", async () => {
      mockCoreApi.createNamespacedPod.mockResolvedValueOnce({ metadata: { name: "runner-old-id" } });
      await manager.spawn(baseConfig);

      manager.rekeySession("old-id", "new-id");

      // Let the async patch fire
      await vi.waitFor(() => {
        expect(mockCoreApi.patchNamespacedPod).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "runner-old-id",
            namespace: "test-ns",
            body: expect.objectContaining({
              metadata: {
                labels: {
                  "session-id": "new-id",
                  role: "session",
                },
              },
            }),
          }),
        );
      });
    });

    it("returns false for unknown session", () => {
      expect(manager.rekeySession("nonexistent", "new-id")).toBe(false);
    });
  });
});

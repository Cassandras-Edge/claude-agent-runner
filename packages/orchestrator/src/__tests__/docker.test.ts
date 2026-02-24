import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SpawnConfig } from "../docker.js";

// We need to mock dockerode before importing DockerManager
const mockContainer = {
  id: "abc123def456",
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
};

const mockNetwork = {
  inspect: vi.fn().mockResolvedValue({}),
};

const mockDockerInstance = {
  ping: vi.fn().mockResolvedValue("OK"),
  createContainer: vi.fn().mockResolvedValue(mockContainer),
  getContainer: vi.fn().mockReturnValue(mockContainer),
  getNetwork: vi.fn().mockReturnValue(mockNetwork),
  createNetwork: vi.fn().mockResolvedValue(undefined),
};

vi.mock("dockerode", () => {
  // Return a class-like constructor
  function MockDocker() {
    return mockDockerInstance;
  }
  return { default: MockDocker };
});

// Import after mock setup
const { DockerManager } = await import("../docker.js");

describe("DockerManager", () => {
  let manager: InstanceType<typeof DockerManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new DockerManager();
  });

  describe("checkConnection", () => {
    it("returns true when Docker is available", async () => {
      expect(await manager.checkConnection()).toBe(true);
    });

    it("returns false when Docker ping fails", async () => {
      mockDockerInstance.ping.mockRejectedValueOnce(new Error("connection refused"));
      expect(await manager.checkConnection()).toBe(false);
    });
  });

  describe("spawn", () => {
    const baseConfig: SpawnConfig = {
      sessionId: "session-1",
      image: "claude-runner:latest",
      orchestratorUrl: "ws://localhost:8081",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
      network: "claude-net",
    };

    it("returns a container ID", async () => {
      const containerId = await manager.spawn(baseConfig);
      expect(containerId).toBe("abc123def456");
    });

    it("throws when CLAUDE_CODE_OAUTH_TOKEN is missing from env", async () => {
      await expect(
        manager.spawn({ ...baseConfig, env: {} })
      ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN missing");
    });

    it("throws when CLAUDE_CODE_OAUTH_TOKEN is empty", async () => {
      await expect(
        manager.spawn({ ...baseConfig, env: { CLAUDE_CODE_OAUTH_TOKEN: "" } })
      ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN missing");
    });

    it("stores the container ID for later retrieval", async () => {
      await manager.spawn(baseConfig);
      expect(manager.getContainerId("session-1")).toBe("abc123def456");
    });

    it("calls docker.createContainer with correct image and labels", async () => {
      await manager.spawn(baseConfig);

      expect(mockDockerInstance.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "claude-runner:latest",
          Labels: expect.objectContaining({
            "claude-orchestrator": "true",
            "session-id": "session-1",
          }),
        })
      );
    });

    it("passes workspace as a bind mount", async () => {
      await manager.spawn({ ...baseConfig, workspace: "/home/user/project" });

      expect(mockDockerInstance.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: expect.arrayContaining(["/home/user/project:/workspace"]),
          }),
        })
      );
    });

    it("passes additional directories as read-only bind mounts", async () => {
      await manager.spawn({ ...baseConfig, additionalDirectories: ["/data/shared"] });

      expect(mockDockerInstance.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: expect.arrayContaining(["/data/shared:/data/shared:ro"]),
          }),
        })
      );
    });

    it("mounts sessionsVolume to /home/runner/.claude", async () => {
      await manager.spawn({ ...baseConfig, sessionsVolume: "claude-sessions" });

      expect(mockDockerInstance.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: expect.arrayContaining(["claude-sessions:/home/runner/.claude"]),
          }),
        })
      );
    });

    it("does not add sessions bind when sessionsVolume is not set", async () => {
      await manager.spawn(baseConfig);

      const call = mockDockerInstance.createContainer.mock.calls[0][0];
      const binds = call.HostConfig?.Binds || [];
      expect(binds.some((b: string) => b.includes(".claude"))).toBe(false);
    });
  });

  describe("kill", () => {
    it("removes the container mapping after kill", async () => {
      const baseConfig: SpawnConfig = {
        sessionId: "session-1",
        image: "claude-runner:latest",
        orchestratorUrl: "ws://localhost:8081",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
        network: "claude-net",
      };

      await manager.spawn(baseConfig);
      expect(manager.getContainerId("session-1")).toBe("abc123def456");

      await manager.kill("session-1");
      expect(manager.getContainerId("session-1")).toBeUndefined();
    });

    it("is a no-op for unknown sessions", async () => {
      await expect(manager.kill("nonexistent")).resolves.toBeUndefined();
    });

    it("calls container.stop and container.remove", async () => {
      const baseConfig: SpawnConfig = {
        sessionId: "session-1",
        image: "claude-runner:latest",
        orchestratorUrl: "ws://localhost:8081",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
        network: "claude-net",
      };

      await manager.spawn(baseConfig);
      await manager.kill("session-1");

      expect(mockContainer.stop).toHaveBeenCalledWith({ t: 5 });
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });
  });

  describe("getContainerId", () => {
    it("returns undefined for unknown sessions", () => {
      expect(manager.getContainerId("unknown")).toBeUndefined();
    });
  });

  describe("ensureNetwork", () => {
    it("does not create network if it already exists", async () => {
      await manager.ensureNetwork("claude-net");
      expect(mockDockerInstance.createNetwork).not.toHaveBeenCalled();
    });

    it("creates network if inspect fails", async () => {
      mockNetwork.inspect.mockRejectedValueOnce(new Error("not found"));
      await manager.ensureNetwork("claude-net");
      expect(mockDockerInstance.createNetwork).toHaveBeenCalledWith({ Name: "claude-net", Driver: "bridge" });
    });
  });
});

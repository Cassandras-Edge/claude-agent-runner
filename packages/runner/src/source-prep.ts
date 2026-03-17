import { execSync, spawn as spawnChild } from "child_process";
import { existsSync, rmSync } from "fs";
import { logger } from "./logger.js";
import { state } from "./state.js";

export function cloneRepo(): void {
  if (!state.REPO) {
    logger.info("runner.git", "repo_not_configured", { session_id: state.SESSION_ID });
    return;
  }
  if (existsSync(`${state.WORKSPACE}/.git`)) {
    logger.info("runner.git", "workspace_already_initialized", { workspace: state.WORKSPACE });
    return;
  }

  let cloneUrl = state.REPO;
  if (state.GIT_TOKEN && cloneUrl.startsWith("https://")) {
    cloneUrl = cloneUrl.replace("https://", `https://x-access-token:${state.GIT_TOKEN}@`);
  }

  logger.info("runner.git", "clone_start", { repo: state.REPO, branch: state.BRANCH, workspace: state.WORKSPACE });
  try {
    execSync(`git clone --branch ${state.BRANCH} --single-branch --depth 1 ${cloneUrl} ${state.WORKSPACE}`, {
      stdio: "inherit",
      timeout: 120_000,
    });
    logger.info("runner.git", "clone_complete", { workspace: state.WORKSPACE });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("runner.git", "clone_failed", {
      session_id: state.SESSION_ID,
      repo: state.REPO,
      branch: state.BRANCH,
      error: message,
    });
    throw new Error(`Git clone failed: ${message}`);
  }
}

export async function syncVault(sendStatus?: (status: string) => void): Promise<void> {
  if (!state.VAULT) return;

  const obsidianAuthToken = process.env.OBSIDIAN_AUTH_TOKEN;
  if (!obsidianAuthToken) {
    throw new Error("OBSIDIAN_AUTH_TOKEN is required for vault sessions");
  }

  const deviceName = `runner-${state.SESSION_ID.slice(0, 8)}`;
  const passwordArgs = process.env.OBSIDIAN_E2EE_PASSWORD
    ? ["--password", process.env.OBSIDIAN_E2EE_PASSWORD]
    : [];

  logger.info("runner.vault", "vault_sync_start", {
    vault: state.VAULT,
    workspace: state.WORKSPACE,
    device: deviceName,
  });

  try {
    try {
      execSync(
        `ob sync-unlink --path ${JSON.stringify(state.WORKSPACE)}`,
        { stdio: "pipe", timeout: 10_000, env: { ...process.env, OBSIDIAN_AUTH_TOKEN: obsidianAuthToken } },
      );
    } catch {}

    execSync(
      ["ob", "sync-setup", "--vault", state.VAULT, "--path", state.WORKSPACE, ...passwordArgs, "--device-name", deviceName]
        .map(a => JSON.stringify(a))
        .join(" "),
      { stdio: "pipe", timeout: 30_000, env: { ...process.env, OBSIDIAN_AUTH_TOKEN: obsidianAuthToken } },
    );

    // Blocking sync with progress reporting
    sendStatus?.("syncing vault");
    await new Promise<void>((resolve, reject) => {
      const syncProc = spawnChild("ob", ["sync", "--path", state.WORKSPACE], {
        stdio: "pipe",
        env: { ...process.env, OBSIDIAN_AUTH_TOKEN: obsidianAuthToken },
      });

      const timeout = setTimeout(() => {
        syncProc.kill();
        reject(new Error("ob sync timed out after 120s"));
      }, 120_000);

      let lastFileCount = 0;
      const progressInterval = setInterval(() => {
        try {
          const count = execSync(
            `find ${JSON.stringify(state.WORKSPACE)} -not -path '*/.obsidian/*' -type f | wc -l`,
            { encoding: "utf-8", timeout: 5000 },
          ).trim();
          const n = parseInt(count, 10);
          if (n !== lastFileCount) {
            lastFileCount = n;
            sendStatus?.(`syncing vault (${n} files)`);
          }
        } catch {}
      }, 2000);

      syncProc.on("exit", (code) => {
        clearTimeout(timeout);
        clearInterval(progressInterval);
        if (code === 0) resolve();
        else reject(new Error(`ob sync exited with code ${code}`));
      });
      syncProc.on("error", (err) => {
        clearTimeout(timeout);
        clearInterval(progressInterval);
        reject(err);
      });
    });

    logger.info("runner.vault", "vault_sync_setup_complete", { vault: state.VAULT, workspace: state.WORKSPACE });
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.()?.trim() || "";
    const message = stderr || (err instanceof Error ? err.message : String(err));
    const hasPassword = passwordArgs.length > 0;
    logger.error("runner.vault", "vault_sync_failed", {
      session_id: state.SESSION_ID,
      vault: state.VAULT,
      has_e2ee_password: hasPassword,
      error: message,
    });
    throw new Error(`Vault sync failed: ${message}`);
  }

  // Obsidian doesn't sync dotfiles. Vault convention: put Claude config in `claude/`
  // (visible folder that syncs) and symlink `.claude` to it so the CLI discovers rules/skills.
  // Use ln -sfn which overwrites any existing symlink.
  const claudeDir = `${state.WORKSPACE}/claude`;
  if (existsSync(claudeDir)) {
    try {
      execSync(`ln -sfn ${claudeDir} ${state.WORKSPACE}/.claude`, { stdio: "pipe" });
      logger.info("runner.vault", "claude_dir_symlinked", { source: claudeDir });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("runner.vault", "claude_dir_symlink_failed", { error: message });
    }
  }

  const lockPath = `${state.WORKSPACE}/.obsidian/.sync.lock`;
  try {
    if (existsSync(lockPath)) {
      rmSync(lockPath, { recursive: true, force: true });
      logger.info("runner.vault", "stale_sync_lock_removed", { path: lockPath });
    }
  } catch (err) {
    logger.warn("runner.vault", "failed_to_remove_sync_lock", {
      path: lockPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    state.vaultSyncProcess = spawnChild("ob", ["sync", "--continuous", "--path", state.WORKSPACE], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
      env: { ...process.env, OBSIDIAN_AUTH_TOKEN: obsidianAuthToken },
    });

    let stderrOutput = "";
    state.vaultSyncProcess.stderr?.on("data", (data: Buffer) => {
      stderrOutput += data.toString();
    });

    state.vaultSyncProcess.on("exit", (code) => {
      if (code !== 0) {
        logger.error("runner.vault", "background_sync_exited", {
          vault: state.VAULT,
          code,
          stderr: stderrOutput.trim().slice(0, 500),
        });
      } else {
        logger.info("runner.vault", "background_sync_stopped", { vault: state.VAULT });
      }
      state.vaultSyncProcess = null;
    });

    logger.info("runner.vault", "background_sync_started", {
      vault: state.VAULT,
      pid: state.vaultSyncProcess.pid,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("runner.vault", "background_sync_failed_to_start", { vault: state.VAULT, error: message });
  }
}

export function stopVaultSync(): void {
  if (state.vaultSyncProcess) {
    logger.info("runner.vault", "stopping_background_sync", {
      vault: state.VAULT,
      pid: state.vaultSyncProcess.pid,
    });
    state.vaultSyncProcess.kill("SIGTERM");
    state.vaultSyncProcess = null;
  }
}

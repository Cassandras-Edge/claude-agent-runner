import { execSync } from "child_process";
import { existsSync } from "fs";
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

/**
 * Prepare a vault workspace. The vault content is already mounted via NFS PVC
 * (kept fresh by the vault-sync daemon). Just create the .claude symlink.
 */
export function prepareVault(): void {
  if (!state.VAULT) return;

  // Obsidian doesn't sync dotfiles. Vault convention: put Claude config in `claude/`
  // (visible folder that syncs) and symlink `.claude` to it so the CLI discovers rules/skills.
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

  logger.info("runner.vault", "vault_prepared", {
    vault: state.VAULT,
    workspace: state.WORKSPACE,
    has_claude_dir: existsSync(claudeDir),
  });
}

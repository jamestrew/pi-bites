/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EnvInfo } from "./types.js";

export async function detectEnv(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<EnvInfo> {
  let isGitRepo = false;
  let branch = "";

  try {
    const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      signal,
      timeout: 5000,
    });
    isGitRepo = result.code === 0 && result.stdout.trim() === "true";
  } catch {
    // Not a git repo or git not installed
  }

  if (!isGitRepo) {
    try {
      const result = await pi.exec("jj", ["root"], { cwd, signal, timeout: 5000 });
      isGitRepo = result.code === 0 && result.stdout.trim().length > 0;
    } catch {
      // Not a jj repo or jj not installed
    }
  }

  if (isGitRepo) {
    try {
      const result = await pi.exec("git", ["branch", "--show-current"], {
        cwd,
        signal,
        timeout: 5000,
      });
      branch = result.code === 0 ? result.stdout.trim() : "unknown";
    } catch {
      branch = "unknown";
    }
  }

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}

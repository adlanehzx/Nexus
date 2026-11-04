/**
 * NEXUS Unified VCS & Worktrees - Worktree Manager
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { randomUUID } from "node:crypto";
import { SymlinkAwarePathChecker } from "@nexus/agent-core";
import type { Worktree } from "@nexus/protocol";
import type {
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  WorktreeStatusResult,
  WorktreeHandoffOptions,
  WorktreeHandoffResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  private async runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      const msg = e.stderr?.trim() ? e.stderr.trim() : (e.message ?? String(err));
      throw new Error(`Git command 'git ${args.join(" ")}' failed: ${msg}`, { cause: err });
    }
  }

  async createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
    const { workspaceRoot, branchName, baseBranch = "HEAD", strategy = "isolated" } = options;

    const worktreePath =
      options.targetPath ??
      NodePath.join(workspaceRoot, ".nexus-worktrees", branchName.replace(/[/\\:]/g, "-"));

    // Ensure path is within workspaceRoot or allowed sandbox
    const isContained = SymlinkAwarePathChecker.isContained(worktreePath, workspaceRoot);
    if (!isContained) {
      throw new Error(
        `Target worktree path '${worktreePath}' is outside workspace root '${workspaceRoot}'`,
      );
    }

    // Ensure parent directory exists
    await NodeFS.promises.mkdir(NodePath.dirname(worktreePath), { recursive: true });

    // Execute git worktree add
    await this.runGit(
      ["worktree", "add", "-b", branchName, worktreePath, baseBranch],
      workspaceRoot,
    );

    const { stdout: headSha } = await this.runGit(["rev-parse", "HEAD"], worktreePath);

    return {
      id: randomUUID(),
      path: worktreePath,
      branch: branchName,
      headCommit: headSha.trim(),
      baseBranch,
      workspaceRoot,
      strategy,
      status: "active",
      isDetached: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async listWorktrees(workspaceRoot: string): Promise<Worktree[]> {
    const { stdout } = await this.runGit(["worktree", "list", "--porcelain"], workspaceRoot);
    const worktrees: Worktree[] = [];

    const blocks = stdout
      .split("\n\n")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
    for (const block of blocks) {
      const lines = block.split("\n");
      let worktreePath = "";
      let headSha = "";
      let branchName = "";
      let isDetached = false;

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.substring(9).trim();
        } else if (line.startsWith("HEAD ")) {
          headSha = line.substring(5).trim();
        } else if (line.startsWith("branch refs/heads/")) {
          branchName = line.substring(18).trim();
        } else if (line === "detached") {
          isDetached = true;
        }
      }

      if (worktreePath) {
        worktrees.push({
          id: randomUUID(),
          path: worktreePath,
          branch: branchName || "detached",
          headCommit: headSha,
          workspaceRoot,
          strategy: "isolated",
          status: "active",
          isDetached,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return worktrees;
  }

  async getStatus(worktreePath: string, workspaceRoot: string): Promise<WorktreeStatusResult> {
    const { stdout: branchOut } = await this.runGit(["branch", "--show-current"], worktreePath);
    const branch = branchOut.trim() || "HEAD";

    const { stdout: statusOut } = await this.runGit(["status", "--porcelain"], worktreePath);
    const modifiedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const line of statusOut.split("\n").filter((l) => l.trim().length > 0)) {
      const code = line.substring(0, 2);
      const file = line.substring(3).trim();
      if (code === "??") {
        untrackedFiles.push(file);
      } else {
        modifiedFiles.push(file);
      }
    }

    const { stdout: headSha } = await this.runGit(["rev-parse", "HEAD"], worktreePath);

    return {
      worktree: {
        id: randomUUID(),
        path: worktreePath,
        branch,
        headCommit: headSha.trim(),
        workspaceRoot,
        strategy: "isolated",
        status: "active",
        isDetached: branch === "HEAD",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      clean: modifiedFiles.length === 0 && untrackedFiles.length === 0,
      modifiedFiles,
      untrackedFiles,
      aheadCount: 0,
      behindCount: 0,
    };
  }

  async removeWorktree(options: RemoveWorktreeOptions): Promise<void> {
    const { workspaceRoot, worktreePath, deleteBranch = false } = options;

    let branchToDelete: string | null = null;
    if (deleteBranch) {
      try {
        const { stdout } = await this.runGit(["branch", "--show-current"], worktreePath);
        branchToDelete = stdout.trim() || null;
      } catch {
        // Ignore branch lookup errors if worktree is already missing
      }
    }

    await this.runGit(["worktree", "remove", "--force", worktreePath], workspaceRoot);

    if (deleteBranch && branchToDelete) {
      await this.runGit(["branch", "-D", branchToDelete], workspaceRoot).catch(() => {
        /* ignore branch delete failure */
      });
    }
  }

  async pruneWorktrees(workspaceRoot: string): Promise<void> {
    await this.runGit(["worktree", "prune"], workspaceRoot);
  }

  async handoff(options: WorktreeHandoffOptions): Promise<WorktreeHandoffResult> {
    const { worktreePath, targetBranch, commitMessage, autoMerge = false } = options;

    // Stage changes
    await this.runGit(["add", "-A"], worktreePath);

    // Commit changes
    await this.runGit(["commit", "-m", commitMessage], worktreePath).catch(() => {
      // Nothing to commit is fine
    });

    const { stdout: commitSha } = await this.runGit(["rev-parse", "HEAD"], worktreePath);
    const { stdout: sourceBranch } = await this.runGit(["branch", "--show-current"], worktreePath);

    let merged = false;
    let conflictFiles: string[] | undefined;

    if (autoMerge) {
      try {
        await this.runGit(["merge", sourceBranch.trim()], worktreePath);
        merged = true;
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string };
        conflictFiles = (e.stdout ?? "").split("\n").filter((l) => l.includes("CONFLICT"));
      }
    }

    return {
      sourceBranch: sourceBranch.trim(),
      targetBranch,
      commitSha: commitSha.trim(),
      merged,
      conflictFiles,
    };
  }
}

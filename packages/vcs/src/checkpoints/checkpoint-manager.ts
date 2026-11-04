/**
 * NEXUS Unified Checkpoint Architecture - Checkpoint Manager
 *
 * Captures differential turn snapshots via isolated Git temporary indexes
 * and enables atomic rollback and diff generation without polluting the user's git tree.
 * Persists checkpoints across restarts via .git/nexus-checkpoints metadata.
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
import type {
  CreateCheckpointOptions,
  RestoreCheckpointOptions,
  DiffCheckpointOptions,
  Checkpoint,
  RollbackResult,
  ThreadTurnDiff,
} from "./types.js";

const execFileAsync = promisify(execFile);

export class CheckpointManager {
  private readonly inMemoryCheckpoints = new Map<string, Checkpoint>();
  private readonly threadLocks = new Map<string, Promise<void>>();

  private async acquireLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prevLock = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release: () => void = () => {
      /* initialized by nextLock */
    };
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, nextLock);

    try {
      await prevLock;
      return await fn();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === nextLock) {
        this.threadLocks.delete(threadId);
      }
    }
  }

  private resolveRealPath(dir: string): string {
    try {
      return NodeFS.realpathSync(dir);
    } catch {
      return NodePath.resolve(dir);
    }
  }

  private async runGit(
    args: string[],
    cwd: string,
    envExtra?: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; stderr: string }> {
    const realCwd = this.resolveRealPath(cwd);
    try {
      return await execFileAsync("git", args, {
        cwd: realCwd,
        env: { ...process.env, ...envExtra },
        maxBuffer: 25 * 1024 * 1024,
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      const msg = e.stderr?.trim() ? e.stderr.trim() : (e.message ?? String(err));
      throw new Error(`Git error during 'git ${args.join(" ")}': ${msg}`, { cause: err });
    }
  }

  private async isGitRepo(cwd: string): Promise<boolean> {
    try {
      const { stdout } = await this.runGit(["rev-parse", "--is-inside-work-tree"], cwd);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async getGitCommonDir(cwd: string): Promise<string> {
    const { stdout } = await this.runGit(["rev-parse", "--git-common-dir"], cwd);
    const trimmed = stdout.trim();
    return NodePath.isAbsolute(trimmed) ? trimmed : NodePath.resolve(cwd, trimmed);
  }

  private getPersistenceFilePath(gitDir: string, threadId: string): string {
    const sanitized = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return NodePath.join(gitDir, "nexus-checkpoints", `${sanitized}.json`);
  }

  private async persistCheckpoint(gitDir: string, checkpoint: Checkpoint): Promise<void> {
    try {
      const storeDir = NodePath.join(gitDir, "nexus-checkpoints");
      await NodeFS.promises.mkdir(storeDir, { recursive: true });
      const filePath = this.getPersistenceFilePath(gitDir, checkpoint.threadId);

      let existing: Checkpoint[] = [];
      try {
        const raw = await NodeFS.promises.readFile(filePath, "utf-8");
        existing = JSON.parse(raw) as Checkpoint[];
      } catch {
        existing = [];
      }

      const index = existing.findIndex((c) => c.turnNumber === checkpoint.turnNumber);
      if (index >= 0) {
        existing[index] = checkpoint;
      } else {
        existing.push(checkpoint);
      }

      await NodeFS.promises.writeFile(filePath, JSON.stringify(existing, null, 2), "utf-8");
    } catch {
      // Persistence fallback non-blocking
    }
  }

  private async loadPersistedCheckpoints(gitDir: string, threadId: string): Promise<Checkpoint[]> {
    try {
      const filePath = this.getPersistenceFilePath(gitDir, threadId);
      const raw = await NodeFS.promises.readFile(filePath, "utf-8");
      return JSON.parse(raw) as Checkpoint[];
    } catch {
      return [];
    }
  }

  async captureCheckpoint(options: CreateCheckpointOptions): Promise<Checkpoint> {
    const { threadId, turnNumber, cwd, description, snapshotRoot, createdBy } = options;

    return this.acquireLock(threadId, async () => {
      const isGit = await this.isGitRepo(cwd);
      let commitHash: string | undefined = undefined;
      let diffBlob: string | undefined = undefined;
      let gitDir: string | undefined = undefined;

      if (isGit) {
        gitDir = await this.getGitCommonDir(cwd);
        const tempIndex = NodePath.join(gitDir, `nexus-checkpoint-idx-${randomUUID()}`);
        const gitEnv = {
          GIT_INDEX_FILE: tempIndex,
          GIT_AUTHOR_NAME: "NEXUS Agent Engine",
          GIT_AUTHOR_EMAIL: "agent@nexus.internal",
          GIT_COMMITTER_NAME: "NEXUS Agent Engine",
          GIT_COMMITTER_EMAIL: "agent@nexus.internal",
        };

        try {
          // Stage current working directory files in isolated temp index
          await this.runGit(["add", "-A"], cwd, gitEnv);

          // Write tree from temp index
          const { stdout: treeSha } = await this.runGit(["write-tree"], cwd, gitEnv);

          // Create commit
          const commitMsg =
            `nexus-checkpoint: thread=${threadId} turn=${turnNumber} ${description ?? ""}`.trim();
          const { stdout: commitShaOut } = await this.runGit(
            ["commit-tree", treeSha.trim(), "-m", commitMsg],
            cwd,
            gitEnv,
          );
          commitHash = commitShaOut.trim();

          // Update checkpoint ref: refs/nexus-checkpoints/<threadId>/<turnNumber>
          const refName = `refs/nexus-checkpoints/${threadId}/${turnNumber}`;
          await this.runGit(["update-ref", refName, commitHash], cwd);

          // Generate diff compared to previous turn ref if it exists
          const prevTurn = turnNumber - 1;
          const prevRef = `refs/nexus-checkpoints/${threadId}/${prevTurn}`;
          try {
            const { stdout: diffOut } = await this.runGit(
              ["diff", "--no-color", prevRef, refName],
              cwd,
            );
            diffBlob = diffOut;
          } catch {
            try {
              const { stdout: diffOut } = await this.runGit(
                ["diff", "--no-color", "HEAD", refName],
                cwd,
              );
              diffBlob = diffOut;
            } catch {
              diffBlob = "";
            }
          }
        } finally {
          await NodeFS.promises.rm(tempIndex, { force: true }).catch(() => {
            /* ignore cleanup failure */
          });
        }
      }

      const checkpoint: Checkpoint = {
        id: randomUUID(),
        threadId,
        turnNumber,
        ...(commitHash ? { commitHash } : {}),
        ...(diffBlob ? { diffBlob } : {}),
        ...(description ? { description } : {}),
        ...(snapshotRoot ? { snapshotRoot } : {}),
        ...(createdBy ? { createdBy } : {}),
        createdAt: new Date().toISOString(),
      };

      this.inMemoryCheckpoints.set(`${threadId}:${turnNumber}`, checkpoint);

      if (gitDir) {
        await this.persistCheckpoint(gitDir, checkpoint);
      }

      return checkpoint;
    });
  }

  async listCheckpoints(threadId: string, cwd?: string): Promise<Checkpoint[]> {
    // Check in-memory first
    const fromMemory = Array.from(this.inMemoryCheckpoints.values()).filter(
      (c) => c.threadId === threadId,
    );

    if (fromMemory.length > 0) {
      return fromMemory.sort((a, b) => a.turnNumber - b.turnNumber);
    }

    // Attempt to load from disk persistence if cwd is supplied or git is available
    if (cwd) {
      try {
        const isGit = await this.isGitRepo(cwd);
        if (isGit) {
          const gitDir = await this.getGitCommonDir(cwd);
          const persisted = await this.loadPersistedCheckpoints(gitDir, threadId);
          for (const c of persisted) {
            this.inMemoryCheckpoints.set(`${threadId}:${c.turnNumber}`, c);
          }
          return persisted.sort((a, b) => a.turnNumber - b.turnNumber);
        }
      } catch {
        // Fallback
      }
    }

    return [];
  }

  async restoreCheckpoint(options: RestoreCheckpointOptions): Promise<RollbackResult> {
    const { threadId, turnNumber, cwd, checkpointId = randomUUID(), dryRun = false } = options;

    return this.acquireLock(threadId, async () => {
      const isGit = await this.isGitRepo(cwd);

      // Rule: Never return success: true when no restoration actually took place
      if (!isGit) {
        return {
          success: false,
          threadId,
          checkpointId,
          rolledBackFiles: [],
          error: `Directory '${cwd}' is not a valid Git repository`,
          timestamp: new Date().toISOString(),
        };
      }

      const refName = `refs/nexus-checkpoints/${threadId}/${turnNumber}`;

      // Verify the ref exists
      let restoredCommitHash: string;
      try {
        const { stdout: headSha } = await this.runGit(["rev-parse", "--verify", refName], cwd);
        restoredCommitHash = headSha.trim();
      } catch {
        return {
          success: false,
          threadId,
          checkpointId,
          rolledBackFiles: [],
          error: `Checkpoint ref '${refName}' does not exist`,
          timestamp: new Date().toISOString(),
        };
      }

      // Compute list of files that differ between current workspace and the checkpoint ref
      let rolledBackFiles: string[];
      try {
        const { stdout: diffFiles } = await this.runGit(["diff", "--name-only", refName], cwd);
        rolledBackFiles = diffFiles
          .split("\n")
          .map((f) => f.trim())
          .filter((f) => f.length > 0);
      } catch {
        rolledBackFiles = [];
      }

      // Also detect untracked files created since checkpoint
      try {
        const { stdout: untracked } = await this.runGit(["status", "--porcelain"], cwd);
        const untrackedFiles = untracked
          .split("\n")
          .filter((line) => line.startsWith("?? "))
          .map((line) => line.slice(3).trim())
          .filter((f) => f.length > 0);

        for (const uf of untrackedFiles) {
          if (!rolledBackFiles.includes(uf)) {
            rolledBackFiles.push(uf);
          }
        }
      } catch {
        // Fallback
      }

      if (dryRun) {
        return {
          success: true,
          threadId,
          checkpointId,
          rolledBackFiles,
          restoredCommitHash,
          timestamp: new Date().toISOString(),
        };
      }

      // Safety Backup Snapshot before performing destructive rollback
      try {
        const gitDir = await this.getGitCommonDir(cwd);
        const backupIndex = NodePath.join(gitDir, `nexus-backup-idx-${randomUUID()}`);
        const gitEnv = {
          GIT_INDEX_FILE: backupIndex,
          GIT_AUTHOR_NAME: "NEXUS Backup",
          GIT_AUTHOR_EMAIL: "backup@nexus.internal",
          GIT_COMMITTER_NAME: "NEXUS Backup",
          GIT_COMMITTER_EMAIL: "backup@nexus.internal",
        };
        try {
          await this.runGit(["add", "-A"], cwd, gitEnv);
          const { stdout: backupTree } = await this.runGit(["write-tree"], cwd, gitEnv);
          const { stdout: backupCommit } = await this.runGit(
            [
              "commit-tree",
              backupTree.trim(),
              "-m",
              `nexus-safety-backup before turn ${turnNumber}`,
            ],
            cwd,
            gitEnv,
          );
          const backupRef = `refs/nexus-checkpoints-backup/${threadId}/${turnNumber}-${Date.now()}`;
          await this.runGit(["update-ref", backupRef, backupCommit.trim()], cwd);
        } finally {
          await NodeFS.promises.rm(backupIndex, { force: true }).catch(() => {
            /* ignore cleanup failure */
          });
        }
      } catch {
        // Safety backup attempt non-blocking
      }

      // Perform atomic restore:
      // 1. Checkout files from checkpoint ref
      await this.runGit(["checkout", refName, "--", "."], cwd);

      // 2. Explicitly remove untracked files created after checkpoint
      try {
        await this.runGit(["clean", "-fd"], cwd);
      } catch {
        // Ignore clean errors
      }

      return {
        success: true,
        threadId,
        checkpointId,
        rolledBackFiles,
        restoredCommitHash,
        timestamp: new Date().toISOString(),
      };
    });
  }

  async diffCheckpoints(options: DiffCheckpointOptions): Promise<string> {
    const { threadId, fromTurn, toTurn, cwd, ignoreWhitespace = false } = options;
    const isGit = await this.isGitRepo(cwd);

    if (!isGit) {
      return "";
    }

    const fromRef = `refs/nexus-checkpoints/${threadId}/${fromTurn}`;
    const toRef = `refs/nexus-checkpoints/${threadId}/${toTurn}`;

    const args = ["diff", "--no-color"];
    if (ignoreWhitespace) {
      args.push("-w");
    }
    args.push(fromRef, toRef);

    const { stdout } = await this.runGit(args, cwd);
    return stdout;
  }

  async getTurnDiff(
    threadId: string,
    fromTurn: number,
    toTurn: number,
    cwd: string,
  ): Promise<ThreadTurnDiff> {
    const diff = await this.diffCheckpoints({ threadId, fromTurn, toTurn, cwd });
    const isGit = await this.isGitRepo(cwd);

    const fromRef = `refs/nexus-checkpoints/${threadId}/${fromTurn}`;
    const toRef = `refs/nexus-checkpoints/${threadId}/${toTurn}`;

    const filesChanged: string[] = [];
    let insertions = 0;
    let deletions = 0;

    if (isGit) {
      try {
        const { stdout: numstat } = await this.runGit(["diff", "--numstat", fromRef, toRef], cwd);
        for (const line of numstat.split("\n")) {
          const parts = line.trim().split("\t");
          if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
            const ins = parseInt(parts[0], 10);
            const del = parseInt(parts[1], 10);
            const file = parts[2];
            if (!isNaN(ins)) insertions += ins;
            if (!isNaN(del)) deletions += del;
            if (file) filesChanged.push(file);
          }
        }
      } catch {
        // Fallback
      }
    }

    return {
      threadId,
      fromTurnCount: fromTurn,
      toTurnCount: toTurn,
      diff,
      filesChanged,
      insertions,
      deletions,
    };
  }
}

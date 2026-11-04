import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CheckpointManager, WorktreeManager } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("Git & Checkpoints Real Integration Tests", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `nexus-git-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    await fs.mkdir(testDir, { recursive: true });

    // Initialize real git repository
    await execFileAsync("git", ["init"], { cwd: testDir });
    await execFileAsync("git", ["config", "user.name", "Test Runner"], { cwd: testDir });
    await execFileAsync("git", ["config", "user.email", "test@nexus.internal"], { cwd: testDir });

    // Initial commit so HEAD exists
    await fs.writeFile(path.join(testDir, "README.md"), "# Initial Repo\n", "utf-8");
    await execFileAsync("git", ["add", "README.md"], { cwd: testDir });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {
      /* cleanup */
    });
  });

  describe("Real Git Worktrees (WorktreeManager)", () => {
    it("creates, inspects, and removes worktree in real git repository", async () => {
      const wtManager = new WorktreeManager();

      const worktree = await wtManager.createWorktree({
        workspaceRoot: testDir,
        branchName: "feature-test-1",
        baseBranch: "HEAD",
        strategy: "isolated",
      });

      expect(worktree.branch).toBe("feature-test-1");
      expect(worktree.status).toBe("active");

      // Verify files in worktree
      const readmeInWorktree = await fs.readFile(path.join(worktree.path, "README.md"), "utf-8");
      expect(readmeInWorktree).toContain("# Initial Repo");

      // Make a change in worktree
      await fs.writeFile(
        path.join(worktree.path, "worktree-file.txt"),
        "hello from worktree\n",
        "utf-8",
      );
      const status = await wtManager.getStatus(worktree.path, testDir);
      expect(status.untrackedFiles.length + status.modifiedFiles.length).toBeGreaterThan(0);

      // List worktrees
      const list = await wtManager.listWorktrees(testDir);
      expect(list.some((w) => w.branch === "feature-test-1")).toBe(true);

      // Remove worktree
      await wtManager.removeWorktree({
        workspaceRoot: testDir,
        worktreePath: worktree.path,
        deleteBranch: true,
      });

      // Verify removed
      const listAfter = await wtManager.listWorktrees(testDir);
      expect(listAfter.some((w) => w.branch === "feature-test-1")).toBe(false);
    });
  });

  describe("Checkpoints Persistence & Restart", () => {
    it("persists checkpoints across process restarts via .git/nexus-checkpoints", async () => {
      const manager1 = new CheckpointManager();
      const threadId = "persistent-thread-101";

      // Turn 1
      await fs.writeFile(path.join(testDir, "app.ts"), "const version = 1;\n", "utf-8");
      const cp1 = await manager1.captureCheckpoint({
        threadId,
        turnNumber: 1,
        cwd: testDir,
        description: "Turn 1: Added version 1",
      });
      expect(cp1.turnNumber).toBe(1);

      // Turn 2
      await fs.writeFile(path.join(testDir, "app.ts"), "const version = 2;\n", "utf-8");
      const cp2 = await manager1.captureCheckpoint({
        threadId,
        turnNumber: 2,
        cwd: testDir,
        description: "Turn 2: Bumped to version 2",
      });
      expect(cp2.turnNumber).toBe(2);

      // Simulate full process restart with fresh manager instance
      const managerAfterRestart = new CheckpointManager();
      const loaded = await managerAfterRestart.listCheckpoints(threadId, testDir);

      expect(loaded.length).toBe(2);
      expect(loaded[0]?.turnNumber).toBe(1);
      expect(loaded[0]?.description).toContain("Turn 1");
      expect(loaded[1]?.turnNumber).toBe(2);
      expect(loaded[1]?.description).toContain("Turn 2");
    });
  });

  describe("Atomic Rollback, Safety Backup, and Untracked Files Cleaning", () => {
    it("atomically restores files, removes untracked files, and creates safety backup", async () => {
      const manager = new CheckpointManager();
      const threadId = "rollback-thread-202";

      // Turn 1: base file
      await fs.writeFile(
        path.join(testDir, "service.ts"),
        "export const service = 'v1';\n",
        "utf-8",
      );
      await manager.captureCheckpoint({
        threadId,
        turnNumber: 1,
        cwd: testDir,
        description: "Turn 1: service v1",
      });

      // Turn 2: modified file and new untracked file
      await fs.writeFile(
        path.join(testDir, "service.ts"),
        "export const service = 'v2-broken';\n",
        "utf-8",
      );
      await fs.writeFile(path.join(testDir, "untracked-garbage.tmp"), "untracked file\n", "utf-8");

      // Verify files before rollback
      const contentBefore = await fs.readFile(path.join(testDir, "service.ts"), "utf-8");
      expect(contentBefore).toContain("v2-broken");

      // Rollback to Turn 1
      const rollbackRes = await manager.restoreCheckpoint({
        threadId,
        turnNumber: 1,
        cwd: testDir,
      });

      expect(rollbackRes.success).toBe(true);
      expect(rollbackRes.rolledBackFiles).toContain("service.ts");

      // 1. Verify service.ts was restored to v1
      const contentAfter = await fs.readFile(path.join(testDir, "service.ts"), "utf-8");
      expect(contentAfter).toContain("export const service = 'v1';");

      // 2. Verify untracked garbage was cleaned
      const untrackedExists = await fs
        .access(path.join(testDir, "untracked-garbage.tmp"))
        .then(() => true)
        .catch(() => false);
      expect(untrackedExists).toBe(false);

      // 3. Verify safety backup ref was created in git
      const { stdout: backupRefs } = await execFileAsync(
        "git",
        ["for-each-ref", "refs/nexus-checkpoints-backup/"],
        {
          cwd: testDir,
        },
      );
      expect(backupRefs).toContain("refs/nexus-checkpoints-backup/");
    });

    it("strictly returns success: false when target checkpoint ref does not exist", async () => {
      const manager = new CheckpointManager();
      const res = await manager.restoreCheckpoint({
        threadId: "non-existent-thread",
        turnNumber: 999,
        cwd: testDir,
      });

      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.error).toContain("does not exist");
      expect(res.rolledBackFiles.length).toBe(0);
    });

    it("strictly returns success: false when cwd is not a git repo", async () => {
      const manager = new CheckpointManager();
      const nonGitDir = path.join(os.tmpdir(), `non-git-${Date.now()}`);
      await fs.mkdir(nonGitDir, { recursive: true });

      const res = await manager.restoreCheckpoint({
        threadId: "thread-1",
        turnNumber: 1,
        cwd: nonGitDir,
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("not a valid Git repository");

      await fs.rm(nonGitDir, { recursive: true, force: true });
    });
  });

  describe("Concurrency & Symlink Safety", () => {
    it("handles concurrent checkpoint captures safely without data race", async () => {
      const manager = new CheckpointManager();
      const threadId = "concurrent-thread-303";

      // Launch multiple captures concurrently
      const captures = await Promise.all([
        manager.captureCheckpoint({
          threadId,
          turnNumber: 1,
          cwd: testDir,
          description: "Concurrent 1",
        }),
        manager.captureCheckpoint({
          threadId,
          turnNumber: 2,
          cwd: testDir,
          description: "Concurrent 2",
        }),
        manager.captureCheckpoint({
          threadId,
          turnNumber: 3,
          cwd: testDir,
          description: "Concurrent 3",
        }),
      ]);

      expect(captures.length).toBe(3);
      const list = await manager.listCheckpoints(threadId, testDir);
      expect(list.length).toBe(3);
    });
  });
});

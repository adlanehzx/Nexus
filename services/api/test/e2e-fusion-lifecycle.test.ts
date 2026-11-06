/**
 * NEXUS E2E Fusion Lifecycle Integration Test
 *
 * Validates the complete unified pipeline:
 * 1. Worktree allocation with isolated Git sandbox
 * 2. PostgreSQL persistence mirroring for worktrees
 * 3. Atomic turn checkpoint capture with temporary Git index
 * 4. PostgreSQL persistence mirroring for checkpoints
 * 5. Differential calculation and atomic rollback
 * 6. Source control link tracking
 * 7. Clean removal and database status updates
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeApi, createAccount, type ApiHarness, type Account } from "./harness.js";

const execFileAsync = promisify(execFile);

describe("E2E Fusion Lifecycle Pipeline", () => {
  let harness: ApiHarness;
  let account: Account;
  let testRepoDir: string;

  beforeAll(async () => {
    harness = await makeApi();
    account = await createAccount(harness);

    testRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-e2e-repo-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: testRepoDir });
    await execFileAsync("git", ["config", "user.name", "NEXUS Test"], { cwd: testRepoDir });
    await execFileAsync("git", ["config", "user.email", "test@nexus.internal"], {
      cwd: testRepoDir,
    });
    await fs.writeFile(path.join(testRepoDir, "README.md"), "# E2E Test Repo\n");
    await execFileAsync("git", ["add", "."], { cwd: testRepoDir });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: testRepoDir });
  });

  afterAll(async () => {
    await harness.close();
    await fs.rm(testRepoDir, { recursive: true, force: true });
  });

  it("executes the full lifecycle: worktree -> DB persist -> checkpoint -> rollback -> source control", async () => {
    const threadId = `e2e-thread-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const branchName = `agent-task-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // 1. Allocate isolated worktree
    const createWorktreeRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/worktrees",
      headers: account.authorization,
      payload: {
        workspaceRoot: testRepoDir,
        branchName,
        baseBranch: "main",
      },
    });

    expect(createWorktreeRes.statusCode).toBe(201);
    const { worktree } = createWorktreeRes.json<{
      worktree: { id: string; branch: string; path: string; status: string };
    }>();
    expect(worktree.branch).toBe(branchName);
    expect(worktree.status).toBe("active");

    // 2. Verify PostgreSQL worktree persistence
    if (harness.app.prisma?.worktree) {
      const persistedWorktree = await harness.app.prisma.worktree.findUnique({
        where: { id: worktree.id },
      });
      expect(persistedWorktree).not.toBeNull();
      expect(persistedWorktree?.branch).toBe(branchName);
      expect(persistedWorktree?.status).toBe("active");
    }

    // 3. Perform code changes in isolated worktree
    const testFile = path.join(worktree.path, "feature.ts");
    await fs.writeFile(testFile, "export const add = (a: number, b: number) => a + b;\n");

    // 4. Capture turn 1 checkpoint
    const checkpointRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/checkpoints",
      headers: account.authorization,
      payload: {
        threadId,
        turnNumber: 1,
        cwd: worktree.path,
        description: "Implemented add function",
      },
    });

    expect(checkpointRes.statusCode).toBe(201);
    const { checkpoint } = checkpointRes.json<{
      checkpoint: { id: string; turnNumber: number; commitHash?: string };
    }>();
    expect(checkpoint.turnNumber).toBe(1);
    expect(checkpoint.commitHash).toBeDefined();

    // 5. Verify PostgreSQL checkpoint persistence
    if (harness.app.prisma?.checkpoint) {
      const persistedCheckpoint = await harness.app.prisma.checkpoint.findUnique({
        where: { id: checkpoint.id },
      });
      expect(persistedCheckpoint).not.toBeNull();
      expect(persistedCheckpoint?.threadId).toBe(threadId);
      expect(persistedCheckpoint?.turnNumber).toBe(1);
    }

    // 6. Mutate file again and capture turn 2
    await fs.writeFile(
      testFile,
      "export const add = (a: number, b: number) => a + b;\nexport const multiply = (a: number, b: number) => a * b;\n",
    );
    const checkpointRes2 = await harness.app.inject({
      method: "POST",
      url: "/api/v1/checkpoints",
      headers: account.authorization,
      payload: {
        threadId,
        turnNumber: 2,
        cwd: worktree.path,
        description: "Added multiply function",
      },
    });
    expect(checkpointRes2.statusCode).toBe(201);

    // 7. Compute turn diff between turn 1 and 2
    const diffRes = await harness.app.inject({
      method: "GET",
      url: `/api/v1/checkpoints/${threadId}/diff?fromTurn=1&toTurn=2&cwd=${encodeURIComponent(String(worktree.path))}`,
      headers: account.authorization,
    });
    expect(diffRes.statusCode).toBe(200);
    const { diff } = diffRes.json<{ diff: { filesChanged: string[] } }>();
    expect(diff.filesChanged).toContain("feature.ts");

    // 8. Rollback to turn 1
    const rollbackRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/checkpoints/rollback",
      headers: account.authorization,
      payload: {
        threadId,
        turnNumber: 1,
        cwd: worktree.path,
      },
    });
    expect(rollbackRes.statusCode).toBe(200);
    expect(rollbackRes.json().result.success).toBe(true);

    const revertedContent = await fs.readFile(testFile, "utf-8");
    expect(revertedContent).not.toContain("multiply");
    expect(revertedContent).toContain("add");

    // 9. Track Source Control PR link
    const linkRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/source-control/links",
      headers: account.authorization,
      payload: {
        provider: "github",
        repoUrl: "https://github.com/adlanehzx/Nexus",
        pullRequestNumber: 42,
        branch: "agent-task-e2e-1",
        threadId: "e2e-thread-01",
      },
    });
    expect(linkRes.statusCode).toBe(201);
    expect(linkRes.json().link.pullRequestNumber).toBe(42);

    // 10. Clean remove worktree
    const removeRes = await harness.app.inject({
      method: "DELETE",
      url: "/api/v1/worktrees",
      headers: account.authorization,
      payload: {
        workspaceRoot: testRepoDir,
        worktreePath: worktree.path,
        force: true,
        deleteBranch: true,
      },
    });
    expect(removeRes.statusCode).toBe(200);

    // 11. Verify DB status is updated to removed
    if (harness.app.prisma?.worktree) {
      const removedWorktree = await harness.app.prisma.worktree.findUnique({
        where: { id: worktree.id },
      });
      expect(removedWorktree?.status).toBe("removed");
    }
  });
});

import { describe, it, expect, vi } from "vitest";
import { SourceControlService, createVcsToolDefinitions } from "../src/index.js";
import type { WorktreeManager } from "../src/index.js";

describe("Unified VCS & Worktree Architecture", () => {
  it("manages SourceControlLinks and PR review guides properly", () => {
    const scService = new SourceControlService();
    const link = scService.linkPullRequest({
      provider: "github",
      repoUrl: "https://github.com/adlanehzx/Nexus",
      pullRequestNumber: 101,
      branch: "feat/deep-fusion",
      checksState: "pending",
      reviewState: "pending",
      watched: false,
      threadId: "thread-abc",
    });

    expect(link.id).toBeDefined();
    expect(link.pullRequestNumber).toBe(101);

    const watched = scService.setWatched(link.id, true);
    expect(watched?.watched).toBe(true);

    const list = scService.listLinks("thread-abc");
    expect(list.length).toBe(1);

    // Guide
    scService.writeReviewGuide({
      guideId: "guide-101",
      repoUrl: "https://github.com/adlanehzx/nexus",
      prNumber: 101,
      summary: "Fusion complete",
      architectureNotes: "Unified VCS layer added",
      criticalPaths: ["packages/vcs"],
      suggestedCheckpoints: ["vcs-init"],
      updatedAt: new Date().toISOString(),
    });

    const guide = scService.readReviewGuide(101);
    expect(guide?.architectureNotes).toBe("Unified VCS layer added");
  });

  it("registers VCS tools into tool definitions and executes them", async () => {
    const scService = new SourceControlService();
    const mockWorktreeManager = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          id: "wt-1",
          path: "/tmp/repo/.nexus-worktrees/test",
          branch: "test",
          headCommit: "abc1234",
          workspaceRoot: "/tmp/repo",
          strategy: "isolated",
          status: "active",
          isDetached: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
      getStatus: vi.fn().mockResolvedValue({
        worktree: { id: "wt-1" },
        clean: true,
        modifiedFiles: [],
        untrackedFiles: [],
        aheadCount: 0,
        behindCount: 0,
      }),
      handoff: vi.fn().mockResolvedValue({
        sourceBranch: "agent/test",
        targetBranch: "master",
        commitSha: "def5678",
        merged: true,
      }),
    } as unknown as WorktreeManager;

    const tools = createVcsToolDefinitions(mockWorktreeManager, scService);
    expect(tools.length).toBe(6);

    const listTool = tools.find((t) => t.name === "t3_worktree_list");
    expect(listTool).toBeDefined();
    const listResult = await listTool!.execute({ workspaceRoot: "/tmp/repo" }, {} as never);
    expect(listResult).toEqual({
      worktrees: expect.arrayContaining([expect.objectContaining({ id: "wt-1" })]),
    });

    const handoffTool = tools.find((t) => t.name === "t3_worktree_handoff");
    expect(handoffTool).toBeDefined();
    const handoffResult = await handoffTool!.execute(
      {
        worktreePath: "/tmp/repo/.nexus-worktrees/test",
        targetBranch: "master",
        commitMessage: "test handoff",
        autoMerge: true,
      },
      {} as never,
    );
    expect(handoffResult).toEqual(expect.objectContaining({ commitSha: "def5678", merged: true }));
  });
});

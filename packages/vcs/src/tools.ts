/**
 * NEXUS Unified VCS & Worktrees - Tool Definitions for Agent Execution
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";
import type { ToolDefinition } from "@nexus/tools";
import type { WorktreeManager } from "./worktree-manager.js";
import type { SourceControlService } from "./source-control.js";
import {
  PullRequestReviewGuideSchema,
  SourceControlLinkSchema,
  SourceControlProviderSchema,
  WorktreeSchema,
} from "@nexus/protocol";

export function createVcsToolDefinitions(
  worktreeManager: WorktreeManager,
  sourceControlService: SourceControlService,
): ToolDefinition<unknown, unknown>[] {
  const listWorktreesTool: ToolDefinition<unknown, unknown> = {
    name: "t3_worktree_list",
    description: "List all active git worktrees for the current workspace root.",
    inputSchema: z.object({
      workspaceRoot: z.string(),
    }),
    outputSchema: z.object({
      worktrees: z.array(WorktreeSchema),
    }),
    riskLevel: "SAFE",
    requiredPermissions: ["device.read"],
    requiresConfirmation: false,
    execute: async (input: unknown) => {
      const { workspaceRoot } = input as { workspaceRoot: string };
      const worktrees = await worktreeManager.listWorktrees(workspaceRoot);
      return { worktrees };
    },
  };

  const statusWorktreeTool: ToolDefinition<unknown, unknown> = {
    name: "t3_worktree_status",
    description: "Get the git status and diff statistics of a specific worktree.",
    inputSchema: z.object({
      worktreePath: z.string(),
      workspaceRoot: z.string(),
    }),
    outputSchema: z.object({
      clean: z.boolean(),
      modifiedFiles: z.array(z.string()),
      untrackedFiles: z.array(z.string()),
      aheadCount: z.number(),
      behindCount: z.number(),
    }),
    riskLevel: "SAFE",
    requiredPermissions: ["device.read"],
    requiresConfirmation: false,
    execute: async (input: unknown) => {
      const { worktreePath, workspaceRoot } = input as {
        worktreePath: string;
        workspaceRoot: string;
      };
      const res = await worktreeManager.getStatus(worktreePath, workspaceRoot);
      return {
        clean: res.clean,
        modifiedFiles: res.modifiedFiles,
        untrackedFiles: res.untrackedFiles,
        aheadCount: res.aheadCount,
        behindCount: res.behindCount,
      };
    },
  };

  const handoffWorktreeTool: ToolDefinition<unknown, unknown> = {
    name: "t3_worktree_handoff",
    description: "Commit worktree changes and optionally merge them to the target branch.",
    inputSchema: z.object({
      worktreePath: z.string(),
      targetBranch: z.string(),
      commitMessage: z.string(),
      autoMerge: z.boolean().default(false),
    }),
    outputSchema: z.object({
      sourceBranch: z.string(),
      targetBranch: z.string(),
      commitSha: z.string(),
      merged: z.boolean(),
      conflictFiles: z.array(z.string()).optional(),
    }),
    riskLevel: "MEDIUM",
    requiredPermissions: ["device.write"],
    requiresConfirmation: false,
    execute: async (input: unknown) => {
      const typed = input as {
        worktreePath: string;
        targetBranch: string;
        commitMessage: string;
        autoMerge?: boolean;
      };
      return await worktreeManager.handoff({
        ...typed,
        autoMerge: typed.autoMerge ?? false,
      });
    },
  };

  const linkPullRequestTool: ToolDefinition<unknown, unknown> = {
    name: "link_pull_request",
    description: "Link a GitHub / GitLab Pull Request to the current agent thread.",
    inputSchema: z.object({
      provider: SourceControlProviderSchema,
      repoUrl: z.string(),
      pullRequestNumber: z.number(),
      branch: z.string(),
      threadId: z.string().optional(),
    }),
    outputSchema: z.object({
      link: SourceControlLinkSchema,
    }),
    riskLevel: "LOW",
    requiredPermissions: ["device.read"],
    requiresConfirmation: false,
    execute: async (input: unknown) => {
      await Promise.resolve();
      const typed = input as {
        provider: z.infer<typeof SourceControlProviderSchema>;
        repoUrl: string;
        pullRequestNumber: number;
        branch: string;
        threadId?: string;
      };
      const link = sourceControlService.linkPullRequest({
        ...typed,
        checksState: "unknown",
        reviewState: "pending",
        watched: false,
      });
      return { link };
    },
  };

  const writePullRequestGuideTool: ToolDefinition<unknown, unknown> = {
    name: "write_pull_request_guides",
    description: "Write structured review and architectural guide for a Pull Request.",
    inputSchema: PullRequestReviewGuideSchema,
    outputSchema: z.object({
      success: z.boolean(),
    }),
    riskLevel: "LOW",
    requiredPermissions: ["device.write"],
    requiresConfirmation: false,
    execute: async (input: unknown) => {
      await Promise.resolve();
      const guide = input as z.infer<typeof PullRequestReviewGuideSchema>;
      sourceControlService.writeReviewGuide(guide);
      return { success: true };
    },
  };

  const readPullRequestGuideTool: ToolDefinition<unknown, unknown> = {
    name: "read_pull_request_guide",
    description: "Read an existing review guide for a given Pull Request number.",
    inputSchema: z.object({
      prNumber: z.number(),
    }),
    outputSchema: z.object({
      guide: PullRequestReviewGuideSchema.optional(),
    }),
    riskLevel: "SAFE",
    requiredPermissions: ["device.read"],
    requiresConfirmation: false,
    execute: async (input: unknown) => {
      await Promise.resolve();
      const { prNumber } = input as { prNumber: number };
      const guide = sourceControlService.readReviewGuide(prNumber);
      return { guide };
    },
  };

  return [
    listWorktreesTool,
    statusWorktreeTool,
    handoffWorktreeTool,
    linkPullRequestTool,
    writePullRequestGuideTool,
    readPullRequestGuideTool,
  ];
}

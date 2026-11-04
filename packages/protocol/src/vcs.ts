/**
 * NEXUS Unified Protocol - VCS and Worktree Schemas
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";

export const SourceControlProviderSchema = z.enum([
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
  "forgejo",
  "gitcafe",
  "local",
]);
export type SourceControlProvider = z.infer<typeof SourceControlProviderSchema>;

export const PullRequestStatusSchema = z.enum(["open", "closed", "merged", "draft"]);
export type PullRequestStatus = z.infer<typeof PullRequestStatusSchema>;

export const ChecksStateSchema = z.enum([
  "pending",
  "success",
  "failure",
  "error",
  "skipped",
  "unknown",
]);
export type ChecksState = z.infer<typeof ChecksStateSchema>;

export const ReviewStateSchema = z.enum([
  "pending",
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const SourceControlLinkSchema = z.object({
  id: z.string().uuid(),
  provider: SourceControlProviderSchema,
  repoUrl: z.string().url(),
  pullRequestNumber: z.number().int().positive().optional(),
  branch: z.string().min(1),
  headSha: z.string().min(7).max(40).optional(),
  checksState: ChecksStateSchema.default("unknown"),
  reviewState: ReviewStateSchema.default("pending"),
  watched: z.boolean().default(false),
  threadId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SourceControlLink = z.infer<typeof SourceControlLinkSchema>;

export const PullRequestReviewGuideSchema = z.object({
  guideId: z.string(),
  repoUrl: z.string().url(),
  prNumber: z.number().int().positive(),
  summary: z.string(),
  architectureNotes: z.string().optional(),
  criticalPaths: z.array(z.string()).default([]),
  suggestedCheckpoints: z.array(z.string()).default([]),
  updatedAt: z.string().datetime(),
});
export type PullRequestReviewGuide = z.infer<typeof PullRequestReviewGuideSchema>;

export const WorktreeStrategySchema = z.enum(["inherit", "branch", "share", "isolated"]);
export type WorktreeStrategy = z.infer<typeof WorktreeStrategySchema>;

export const WorktreeStatusSchema = z.enum(["active", "merged", "cleaned", "stale"]);
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

export const WorktreeSchema = z.object({
  id: z.string().uuid(),
  path: z.string().min(1),
  branch: z.string().min(1),
  headCommit: z.string().optional(),
  baseBranch: z.string().optional(),
  workspaceRoot: z.string().min(1),
  strategy: WorktreeStrategySchema.default("isolated"),
  status: WorktreeStatusSchema.default("active"),
  isDetached: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const WorktreeCreateInputSchema = z.object({
  workspaceRoot: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().optional(),
  strategy: WorktreeStrategySchema.default("isolated"),
});
export type WorktreeCreateInput = z.infer<typeof WorktreeCreateInputSchema>;

export const WorktreeHandoffInputSchema = z.object({
  worktreeId: z.string().uuid(),
  commitMessage: z.string().min(1),
  mergeBack: z.boolean().default(false),
  deleteWorktree: z.boolean().default(true),
});
export type WorktreeHandoffInput = z.infer<typeof WorktreeHandoffInputSchema>;

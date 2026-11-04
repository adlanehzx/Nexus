/**
 * NEXUS Unified VCS & Worktrees - Types and Interfaces
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Worktree, WorktreeStrategy } from "@nexus/protocol";

export interface CreateWorktreeOptions {
  workspaceRoot: string;
  branchName: string;
  baseBranch?: string | undefined;
  targetPath?: string | undefined;
  strategy?: WorktreeStrategy | undefined;
  userId?: string | undefined;
}

export interface RemoveWorktreeOptions {
  workspaceRoot: string;
  worktreePath: string;
  deleteBranch?: boolean | undefined;
}

export interface WorktreeStatusResult {
  worktree: Worktree;
  clean: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  aheadCount: number;
  behindCount: number;
}

export interface WorktreeHandoffOptions {
  worktreePath: string;
  targetBranch: string;
  commitMessage: string;
  autoMerge?: boolean;
}

export interface WorktreeHandoffResult {
  sourceBranch: string;
  targetBranch: string;
  commitSha: string;
  merged: boolean;
  conflictFiles?: string[] | undefined;
}

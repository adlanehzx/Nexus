/**
 * NEXUS Unified Protocol - Checkpoint and Rollback Schemas
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";

export const TurnCountRangeSchema = z
  .object({
    fromTurnCount: z.number().int().nonnegative(),
    toTurnCount: z.number().int().nonnegative(),
  })
  .refine((data) => data.fromTurnCount <= data.toTurnCount, {
    message: "fromTurnCount must be less than or equal to toTurnCount",
  });
export type TurnCountRange = z.infer<typeof TurnCountRangeSchema>;

export const ThreadTurnDiffSchema = z.object({
  threadId: z.string().min(1),
  fromTurnCount: z.number().int().nonnegative(),
  toTurnCount: z.number().int().nonnegative(),
  diff: z.string(),
  filesChanged: z.array(z.string()).default([]),
  insertions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
});
export type ThreadTurnDiff = z.infer<typeof ThreadTurnDiffSchema>;

export const CheckpointSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().min(1),
  turnNumber: z.number().int().nonnegative(),
  commitHash: z.string().min(7).max(40).optional(),
  diffBlob: z.string().optional(),
  description: z.string().optional(),
  snapshotRoot: z.string().optional(),
  createdAt: z.string().datetime(),
  createdBy: z.string().optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const CreateCheckpointInputSchema = z.object({
  threadId: z.string().min(1),
  turnNumber: z.number().int().nonnegative(),
  workspaceRoot: z.string().min(1),
  description: z.string().optional(),
  createdBy: z.string().optional(),
});
export type CreateCheckpointInput = z.infer<typeof CreateCheckpointInputSchema>;

export const RollbackToCheckpointInputSchema = z.object({
  threadId: z.string().min(1),
  checkpointId: z.string().uuid(),
  targetTurnNumber: z.number().int().nonnegative(),
  workspaceRoot: z.string().min(1),
  restoreWorktree: z.boolean().default(true),
});
export type RollbackToCheckpointInput = z.infer<typeof RollbackToCheckpointInputSchema>;

export const RollbackResultSchema = z.object({
  success: z.boolean(),
  threadId: z.string().min(1),
  checkpointId: z.string().uuid(),
  rolledBackFiles: z.array(z.string()),
  restoredCommitHash: z.string().optional(),
  timestamp: z.string().datetime(),
  error: z.string().optional(),
});
export type RollbackResult = z.infer<typeof RollbackResultSchema>;

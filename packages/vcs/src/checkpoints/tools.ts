/**
 * NEXUS Unified Checkpoint Architecture - Tool Definitions
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";
import type { ToolDefinition } from "@nexus/tools";
import type { CheckpointManager } from "./checkpoint-manager.js";
import { CheckpointSchema, RollbackResultSchema, ThreadTurnDiffSchema } from "@nexus/protocol";

export function createCheckpointToolDefinitions(
  checkpointManager: CheckpointManager,
): ToolDefinition<unknown, unknown>[] {
  const createCheckpointTool: ToolDefinition<unknown, unknown> = {
    name: "checkpoint_create",
    description: "Capture an isolated git checkpoint for the current thread and turn.",
    inputSchema: z.object({
      threadId: z.string(),
      turnNumber: z.number().int().nonnegative(),
      cwd: z.string(),
      description: z.string().optional(),
      worktreeId: z.string().optional(),
    }),
    outputSchema: z.object({
      checkpoint: CheckpointSchema,
    }),
    riskLevel: "LOW",
    requiredPermissions: ["device.write"],
    requiresConfirmation: false,
    execute: async (input: unknown) => {
      const typed = input as {
        threadId: string;
        turnNumber: number;
        cwd: string;
        description?: string;
        worktreeId?: string;
      };
      const checkpoint = await checkpointManager.captureCheckpoint(typed);
      return { checkpoint };
    },
  };

  const rollbackCheckpointTool: ToolDefinition<unknown, unknown> = {
    name: "checkpoint_rollback",
    description: "Atomically rollback the working tree to a previously recorded turn checkpoint.",
    inputSchema: z.object({
      threadId: z.string(),
      turnNumber: z.number().int().nonnegative(),
      cwd: z.string(),
      worktreeId: z.string().optional(),
      dryRun: z.boolean().default(false),
    }),
    outputSchema: z.object({
      result: RollbackResultSchema,
    }),
    riskLevel: "HIGH",
    requiredPermissions: ["device.write"],
    requiresConfirmation: true,
    execute: async (input: unknown) => {
      const typed = input as {
        threadId: string;
        turnNumber: number;
        cwd: string;
        worktreeId?: string;
        dryRun?: boolean;
      };
      const result = await checkpointManager.restoreCheckpoint(typed);
      return { result };
    },
  };

  const diffCheckpointTool: ToolDefinition<unknown, unknown> = {
    name: "checkpoint_diff",
    description: "Compute unified diff between two turn checkpoints for a thread.",
    inputSchema: z.object({
      threadId: z.string(),
      fromTurn: z.number().int().nonnegative(),
      toTurn: z.number().int().nonnegative(),
      cwd: z.string(),
    }),
    outputSchema: z.object({
      turnDiff: ThreadTurnDiffSchema,
    }),
    riskLevel: "SAFE",
    requiredPermissions: ["device.read"],
    requiresConfirmation: false,
    execute: async (input: unknown) => {
      const { threadId, fromTurn, toTurn, cwd } = input as {
        threadId: string;
        fromTurn: number;
        toTurn: number;
        cwd: string;
      };
      const turnDiff = await checkpointManager.getTurnDiff(threadId, fromTurn, toTurn, cwd);
      return { turnDiff };
    },
  };

  return [createCheckpointTool, rollbackCheckpointTool, diffCheckpointTool];
}

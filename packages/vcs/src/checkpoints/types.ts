/**
 * NEXUS Unified Checkpoint Architecture - Types
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Checkpoint, RollbackResult, ThreadTurnDiff } from "@nexus/protocol";

export interface CreateCheckpointOptions {
  threadId: string;
  turnNumber: number;
  cwd: string;
  description?: string | undefined;
  snapshotRoot?: string | undefined;
  createdBy?: string | undefined;
}

export interface RestoreCheckpointOptions {
  threadId: string;
  turnNumber: number;
  cwd: string;
  checkpointId?: string | undefined;
  dryRun?: boolean | undefined;
}

export interface DiffCheckpointOptions {
  threadId: string;
  fromTurn: number;
  toTurn: number;
  cwd: string;
  ignoreWhitespace?: boolean | undefined;
}

export type { Checkpoint, RollbackResult, ThreadTurnDiff };

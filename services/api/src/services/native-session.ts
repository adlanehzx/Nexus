/**
 * NEXUS Native Session Resumption & Guardrails Service (LOT D)
 *
 * Implements durable checkpoint resumption, anti-derivation validation,
 * and ensures human approvals are strictly bounded and never extended silently.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import { uuidv7 } from "@nexus/shared";

export interface SessionTurnCheckpoint {
  checkpointId: string;
  turnNumber: number;
  commitHash?: string | undefined;
  timestamp: string;
  status: "completed" | "interrupted" | "failed";
}

export interface BoundedToolApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  payloadHash: string;
  approvedAt: string;
  consumed: boolean;
}

export class ApprovalDerivationError extends Error {
  readonly code = "APPROVAL_DERIVATION_DETECTED";

  constructor(message: string) {
    super(message);
    this.name = "ApprovalDerivationError";
  }
}

export function computePayloadHash(payload: unknown): string {
  if (payload !== null && typeof payload === "object") {
    const sortedKeys = Object.keys(payload).sort();
    const json = JSON.stringify(payload, sortedKeys);
    return createHash("sha256").update(json).digest("hex");
  }
  const json = JSON.stringify(payload);
  return createHash("sha256").update(json).digest("hex");
}

export class NativeSessionManager {
  private readonly checkpoints = new Map<string, SessionTurnCheckpoint[]>();
  private readonly approvals = new Map<string, BoundedToolApproval>();

  /**
   * Records a turn checkpoint for native resumption
   */
  recordCheckpoint(
    threadId: string,
    turnNumber: number,
    commitHash?: string,
  ): SessionTurnCheckpoint {
    const list = this.checkpoints.get(threadId) ?? [];
    const checkpoint: SessionTurnCheckpoint = {
      checkpointId: uuidv7(),
      turnNumber,
      commitHash,
      timestamp: new Date().toISOString(),
      status: "completed",
    };
    list.push(checkpoint);
    this.checkpoints.set(threadId, list);
    return checkpoint;
  }

  getLatestCheckpoint(threadId: string): SessionTurnCheckpoint | undefined {
    const list = this.checkpoints.get(threadId) ?? [];
    return list.length > 0 ? list[list.length - 1] : undefined;
  }

  /**
   * Registers a human approval strictly bound to toolName and payload hash.
   */
  registerApproval(toolCallId: string, toolName: string, payload: unknown): BoundedToolApproval {
    const payloadHash = computePayloadHash(payload);
    const approval: BoundedToolApproval = {
      approvalId: uuidv7(),
      toolCallId,
      toolName,
      payloadHash,
      approvedAt: new Date().toISOString(),
      consumed: false,
    };
    this.approvals.set(toolCallId, approval);
    return approval;
  }

  /**
   * Verifies and consumes human approval before tool execution.
   * Throws ApprovalDerivationError if payload has changed since approval!
   */
  consumeApproval(toolCallId: string, toolName: string, actualPayload: unknown): void {
    const approval = this.approvals.get(toolCallId);
    if (!approval) {
      throw new ApprovalDerivationError(`No human approval found for tool call '${toolCallId}'`);
    }

    if (approval.consumed) {
      throw new ApprovalDerivationError(
        `Approval for tool call '${toolCallId}' has already been consumed (replay disallowed)`,
      );
    }

    if (approval.toolName !== toolName) {
      throw new ApprovalDerivationError(
        `Approval tool mismatch: approved for '${approval.toolName}', but invoked '${toolName}'`,
      );
    }

    const actualHash = computePayloadHash(actualPayload);
    if (approval.payloadHash !== actualHash) {
      throw new ApprovalDerivationError(
        `Approval payload mismatch: context or arguments derived since approval was granted. Re-confirmation required!`,
      );
    }

    approval.consumed = true;
  }
}

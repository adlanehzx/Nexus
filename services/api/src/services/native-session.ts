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

export function canonicalizeToJson(value: unknown, seen = new Set<unknown>()): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ApprovalDerivationError(
        "Non-finite numbers (NaN/Infinity) are not allowed in approval payload",
      );
    }
    return Object.is(value, -0) ? "0" : value.toString();
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new ApprovalDerivationError(`Unsupported value type: ${typeof value}`);
  }

  if (seen.has(value)) {
    throw new ApprovalDerivationError("Circular reference detected in approval payload");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const parts = value.map((item) => canonicalizeToJson(item, seen));
      return `[${parts.join(",")}]`;
    }

    // Reject objects with custom prototype chains to prevent prototype pollution bypasses
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      throw new ApprovalDerivationError(
        "Objects with custom prototype chains are not permitted in approval payloads",
      );
    }

    // Retrieve all own property names, including __proto__, constructor, prototype
    const keys = Object.getOwnPropertyNames(value).sort();
    const parts: string[] = [];

    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.get !== undefined || desc.set !== undefined) {
        throw new ApprovalDerivationError(
          `Accessor properties on '${key}' are not permitted in approval payload`,
        );
      }
      if (desc.value === undefined) {
        throw new ApprovalDerivationError(
          `Undefined property value for '${key}' is not allowed in canonical JSON`,
        );
      }
      const valStr = canonicalizeToJson(desc.value, seen);
      parts.push(`${JSON.stringify(key)}:${valStr}`);
    }

    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function computePayloadHash(payload: unknown): string {
  const json = canonicalizeToJson(payload);
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

/**
 * NEXUS Transactional Orchestration - Persistent Leases with Fencing Tokens
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface ExecutionLease {
  readonly resourceId: string;
  readonly holderId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly renewCount: number;
}

export interface LeaseManager {
  acquire(resourceId: string, holderId: string, ttlMs: number): Promise<ExecutionLease | null>;
  renew(
    resourceId: string,
    holderId: string,
    fencingToken: number,
    ttlMs: number,
  ): Promise<ExecutionLease | null>;
  release(resourceId: string, holderId: string, fencingToken: number): Promise<boolean>;
  verifyToken(resourceId: string, fencingToken: number): Promise<boolean>;
  getLease(resourceId: string): Promise<ExecutionLease | null>;
}

export class InMemoryLeaseManager implements LeaseManager {
  private readonly leases = new Map<string, ExecutionLease>();
  private currentFencingTokenSequence = 1000;

  async acquire(
    resourceId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<ExecutionLease | null> {
    await Promise.resolve();
    const now = Date.now();
    const existing = this.leases.get(resourceId);

    if (existing) {
      const expiresAt = new Date(existing.expiresAt).getTime();
      if (expiresAt > now && existing.holderId !== holderId) {
        // Lease is actively held by someone else
        return null;
      }
    }

    this.currentFencingTokenSequence++;
    const fencingToken = this.currentFencingTokenSequence;
    const acquiredAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const lease: ExecutionLease = {
      resourceId,
      holderId,
      fencingToken,
      acquiredAt,
      expiresAt,
      renewCount: 0,
    };

    this.leases.set(resourceId, lease);
    return lease;
  }

  async renew(
    resourceId: string,
    holderId: string,
    fencingToken: number,
    ttlMs: number,
  ): Promise<ExecutionLease | null> {
    await Promise.resolve();
    const existing = this.leases.get(resourceId);
    if (!existing) return null;

    if (existing.holderId !== holderId || existing.fencingToken !== fencingToken) {
      return null;
    }

    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const renewed: ExecutionLease = {
      ...existing,
      expiresAt,
      renewCount: existing.renewCount + 1,
    };

    this.leases.set(resourceId, renewed);
    return renewed;
  }

  async release(resourceId: string, holderId: string, fencingToken: number): Promise<boolean> {
    await Promise.resolve();
    const existing = this.leases.get(resourceId);
    if (!existing) return false;

    if (existing.holderId === holderId && existing.fencingToken === fencingToken) {
      this.leases.delete(resourceId);
      return true;
    }

    return false;
  }

  async verifyToken(resourceId: string, fencingToken: number): Promise<boolean> {
    await Promise.resolve();
    const existing = this.leases.get(resourceId);
    if (!existing) return false;

    const now = Date.now();
    const expiresAt = new Date(existing.expiresAt).getTime();
    if (expiresAt <= now) return false;

    return existing.fencingToken === fencingToken;
  }

  async getLease(resourceId: string): Promise<ExecutionLease | null> {
    await Promise.resolve();
    const existing = this.leases.get(resourceId);
    if (!existing) return null;

    const now = Date.now();
    const expiresAt = new Date(existing.expiresAt).getTime();
    if (expiresAt <= now) {
      this.leases.delete(resourceId);
      return null;
    }

    return existing;
  }
}

/**
 * NEXUS Transactional Orchestration - Transactional Outbox
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { uuidv7 } from "@nexus/shared";

export type OutboxStatus = "pending" | "published" | "failed" | "dead_letter";

export interface TransactionalOutboxMessage<TPayload = unknown> {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: TPayload;
  readonly headers: Record<string, string>;
  readonly status: OutboxStatus;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly createdAt: string;
  readonly publishedAt?: string;
  readonly lastError?: string;
}

export interface EnqueueOutboxInput<TPayload = unknown> {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: TPayload;
  headers?: Record<string, string>;
  maxRetries?: number;
}

export interface TransactionalOutbox {
  enqueue(messages: EnqueueOutboxInput[]): Promise<TransactionalOutboxMessage[]>;
  fetchPending(batchSize?: number): Promise<TransactionalOutboxMessage[]>;
  markPublished(ids: string[]): Promise<void>;
  markFailed(id: string, error: string): Promise<OutboxStatus>;
  processBatch(
    publisher: (msg: TransactionalOutboxMessage) => Promise<void>,
    batchSize?: number,
  ): Promise<{ published: number; failed: number }>;
}

export class InMemoryTransactionalOutbox implements TransactionalOutbox {
  private readonly messages = new Map<string, TransactionalOutboxMessage>();

  async enqueue(inputs: EnqueueOutboxInput[]): Promise<TransactionalOutboxMessage[]> {
    const created: TransactionalOutboxMessage[] = [];
    const now = new Date().toISOString();

    for (const input of inputs) {
      const msg: TransactionalOutboxMessage = {
        id: uuidv7(),
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload,
        headers: input.headers ?? {},
        status: "pending",
        retryCount: 0,
        maxRetries: input.maxRetries ?? 5,
        createdAt: now,
      };
      this.messages.set(msg.id, msg);
      created.push(msg);
    }

    return created;
  }

  async fetchPending(batchSize = 50): Promise<TransactionalOutboxMessage[]> {
    const pending: TransactionalOutboxMessage[] = [];
    for (const msg of this.messages.values()) {
      if (msg.status === "pending" || msg.status === "failed") {
        if (msg.retryCount < msg.maxRetries) {
          pending.push(msg);
          if (pending.length >= batchSize) break;
        }
      }
    }
    return pending;
  }

  async markPublished(ids: string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const id of ids) {
      const msg = this.messages.get(id);
      if (msg) {
        this.messages.set(id, {
          ...msg,
          status: "published",
          publishedAt: now,
        });
      }
    }
  }

  async markFailed(id: string, error: string): Promise<OutboxStatus> {
    const msg = this.messages.get(id);
    if (!msg) return "failed";

    const nextRetry = msg.retryCount + 1;
    const newStatus: OutboxStatus = nextRetry >= msg.maxRetries ? "dead_letter" : "failed";

    this.messages.set(id, {
      ...msg,
      status: newStatus,
      retryCount: nextRetry,
      lastError: error,
    });

    return newStatus;
  }

  async processBatch(
    publisher: (msg: TransactionalOutboxMessage) => Promise<void>,
    batchSize = 50,
  ): Promise<{ published: number; failed: number }> {
    const pending = await this.fetchPending(batchSize);
    let published = 0;
    let failed = 0;

    for (const msg of pending) {
      try {
        await publisher(msg);
        await this.markPublished([msg.id]);
        published++;
      } catch (err) {
        await this.markFailed(msg.id, err instanceof Error ? err.message : String(err));
        failed++;
      }
    }

    return { published, failed };
  }

  getPendingCount(): number {
    let count = 0;
    for (const msg of this.messages.values()) {
      if ((msg.status === "pending" || msg.status === "failed") && msg.retryCount < msg.maxRetries) {
        count++;
      }
    }
    return count;
  }

  getDeadLetterCount(): number {
    let count = 0;
    for (const msg of this.messages.values()) {
      if (msg.status === "dead_letter") {
        count++;
      }
    }
    return count;
  }
}

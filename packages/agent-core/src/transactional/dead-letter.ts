/**
 * NEXUS Transactional Orchestration - Dead Letter Queue
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { uuidv7 } from "@nexus/shared";

export interface DeadLetterEntry {
  readonly id: string;
  readonly origin: "outbox" | "inbox" | "event_stream";
  readonly originalMessageId: string;
  readonly topicOrType: string;
  readonly payload: unknown;
  readonly error: string;
  readonly failedAt: string;
  readonly replayCount: number;
}

export interface DeadLetterQueue {
  enqueue(entry: Omit<DeadLetterEntry, "id" | "failedAt" | "replayCount">): Promise<DeadLetterEntry>;
  list(filter?: { origin?: string; limit?: number }): Promise<DeadLetterEntry[]>;
  get(id: string): Promise<DeadLetterEntry | undefined>;
  replay(id: string, handler: (entry: DeadLetterEntry) => Promise<boolean>): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

export class InMemoryDeadLetterQueue implements DeadLetterQueue {
  private readonly entries = new Map<string, DeadLetterEntry>();

  async enqueue(
    entry: Omit<DeadLetterEntry, "id" | "failedAt" | "replayCount">,
  ): Promise<DeadLetterEntry> {
    const item: DeadLetterEntry = {
      id: uuidv7(),
      origin: entry.origin,
      originalMessageId: entry.originalMessageId,
      topicOrType: entry.topicOrType,
      payload: entry.payload,
      error: entry.error,
      failedAt: new Date().toISOString(),
      replayCount: 0,
    };
    this.entries.set(item.id, item);
    return item;
  }

  async list(filter?: { origin?: string; limit?: number }): Promise<DeadLetterEntry[]> {
    let list = [...this.entries.values()];
    if (filter?.origin) {
      list = list.filter((e) => e.origin === filter.origin);
    }
    if (filter?.limit && filter.limit > 0) {
      list = list.slice(0, filter.limit);
    }
    return list;
  }

  async get(id: string): Promise<DeadLetterEntry | undefined> {
    return this.entries.get(id);
  }

  async replay(id: string, handler: (entry: DeadLetterEntry) => Promise<boolean>): Promise<boolean> {
    const item = this.entries.get(id);
    if (!item) return false;

    const success = await handler(item);
    if (success) {
      this.entries.delete(id);
      return true;
    }

    this.entries.set(id, {
      ...item,
      replayCount: item.replayCount + 1,
    });
    return false;
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
}

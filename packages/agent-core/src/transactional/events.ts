/**
 * NEXUS Transactional Orchestration - Event Sourcing Primitives
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";
import { uuidv7 } from "@nexus/shared";

export const CriticalMissionEventTypeSchema = z.enum([
  "mission.created",
  "mission.planned",
  "mission.started",
  "mission.step_started",
  "mission.step_completed",
  "mission.waiting_confirmation",
  "mission.confirmation_resolved",
  "mission.resumed",
  "mission.completed",
  "mission.cancelled",
  "mission.failed",
  "tool.execution_requested",
  "tool.execution_completed",
  "tool.execution_failed",
]);
export type CriticalMissionEventType = z.infer<typeof CriticalMissionEventTypeSchema>;

export interface MissionEvent<TPayload = Record<string, unknown>> {
  readonly id: string;
  readonly missionId: string;
  readonly type: CriticalMissionEventType;
  readonly version: number;
  readonly timestamp: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly payload: TPayload;
  readonly metadata: Record<string, unknown>;
}

export class OptimisticLockingError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;
  readonly aggregateId: string;

  constructor(aggregateId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Optimistic locking conflict on aggregate '${aggregateId}': expected version ${expectedVersion}, but found ${actualVersion}`,
    );
    this.name = "OptimisticLockingError";
    this.aggregateId = aggregateId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export interface AppendEventInput<TPayload = Record<string, unknown>> {
  missionId: string;
  type: CriticalMissionEventType;
  expectedVersion: number;
  correlationId: string;
  causationId?: string;
  payload: TPayload;
  metadata?: Record<string, unknown>;
}

export interface MissionEventStore {
  append(input: AppendEventInput): Promise<MissionEvent>;
  getEvents(missionId: string, fromVersion?: number): Promise<MissionEvent[]>;
  getAllEvents(fromTimestamp?: string): Promise<MissionEvent[]>;
}

/**
 * In-Memory Mission Event Store with strict optimistic locking validation
 */
export class InMemoryMissionEventStore implements MissionEventStore {
  private readonly eventsByMission = new Map<string, MissionEvent[]>();
  private readonly allEvents: MissionEvent[] = [];

  async append(input: AppendEventInput): Promise<MissionEvent> {
    await Promise.resolve();
    const existing = this.eventsByMission.get(input.missionId) ?? [];
    const currentVersion = existing.length > 0 ? existing[existing.length - 1]!.version : 0;

    if (input.expectedVersion !== currentVersion) {
      throw new OptimisticLockingError(input.missionId, input.expectedVersion, currentVersion);
    }

    const nextVersion = currentVersion + 1;
    const event: MissionEvent = {
      id: uuidv7(),
      missionId: input.missionId,
      type: input.type,
      version: nextVersion,
      timestamp: new Date().toISOString(),
      correlationId: input.correlationId,
      causationId: input.causationId,
      payload: input.payload,
      metadata: input.metadata ?? {},
    };

    existing.push(event);
    this.eventsByMission.set(input.missionId, existing);
    this.allEvents.push(event);

    return event;
  }

  async getEvents(missionId: string, fromVersion = 0): Promise<MissionEvent[]> {
    await Promise.resolve();
    const list = this.eventsByMission.get(missionId) ?? [];
    return list.filter((e) => e.version >= fromVersion);
  }

  async getAllEvents(fromTimestamp?: string): Promise<MissionEvent[]> {
    await Promise.resolve();
    if (!fromTimestamp) return [...this.allEvents];
    return this.allEvents.filter((e) => e.timestamp >= fromTimestamp);
  }
}

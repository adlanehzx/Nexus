/**
 * NEXUS Transactional Orchestration - Reconciliation Engine
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { MissionEventStore } from "./events.js";
import type { TransactionalOutbox } from "./outbox.js";
import type { LeaseManager } from "./leases.js";
import type { DeadLetterQueue } from "./dead-letter.js";
import { projectMission } from "./projection.js";

export interface ReconciliationReport {
  timestamp: string;
  expiredLeasesDetected: number;
  outboxPublished: number;
  outboxFailed: number;
  deadLettersEnqueued: number;
  reconciledMissions: number;
}

export class ReconciliationEngine {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly eventStore: MissionEventStore;
  private readonly outbox: TransactionalOutbox;
  private readonly leaseManager: LeaseManager;
  private readonly deadLetterQueue: DeadLetterQueue;
  private readonly publisher?: ((msg: unknown) => Promise<void>) | undefined;

  constructor(
    eventStore: MissionEventStore,
    outbox: TransactionalOutbox,
    leaseManager: LeaseManager,
    deadLetterQueue: DeadLetterQueue,
    publisher?: (msg: unknown) => Promise<void>,
  ) {
    this.eventStore = eventStore;
    this.outbox = outbox;
    this.leaseManager = leaseManager;
    this.deadLetterQueue = deadLetterQueue;
    this.publisher = publisher;
  }

  getDeadLetterQueue(): DeadLetterQueue {
    return this.deadLetterQueue;
  }

  async runSinglePass(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      timestamp: new Date().toISOString(),
      expiredLeasesDetected: 0,
      outboxPublished: 0,
      outboxFailed: 0,
      deadLettersEnqueued: 0,
      reconciledMissions: 0,
    };

    // 1. Process pending outbox entries
    if (this.publisher) {
      const { published, failed } = await this.outbox.processBatch(this.publisher, 100);
      report.outboxPublished = published;
      report.outboxFailed = failed;
    }

    // 2. Identify dangling missions from event store
    const allEvents = await this.eventStore.getAllEvents();
    const missionIds = [...new Set(allEvents.map((e) => e.missionId))];

    for (const missionId of missionIds) {
      const events = await this.eventStore.getEvents(missionId);
      const projection = projectMission(events);

      if (projection && projection.phase === "running") {
        const lease = await this.leaseManager.getLease(missionId);
        if (!lease) {
          // Mission is marked running but lease has expired or was never renewed!
          report.expiredLeasesDetected++;
          // Append mission.failed or trigger recovery event
          await this.eventStore.append({
            missionId,
            type: "mission.failed",
            expectedVersion: projection.version,
            correlationId: projection.correlationId,
            payload: {
              error: "Worker lease expired while mission was in running phase (crash recovery)",
            },
          });
          report.reconciledMissions++;
        }
      }
    }

    return report;
  }

  startPeriodic(intervalMs = 15000): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(() => {
      void this.runSinglePass().catch(() => {});
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

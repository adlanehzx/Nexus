/**
 * NEXUS Unified Telemetry Supervisor - Process and Child Process Monitoring
 *
 * Samples CPU and memory metrics for agent runs, turns, and spawned subprocesses.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as os from "node:os";
import type { ResourceTelemetry, TelemetryReport } from "@nexus/protocol";

export interface TelemetrySupervisorOptions {
  hostId?: string;
  agentInstanceId: string;
}

export class TelemetrySupervisor {
  private readonly hostId: string;
  private readonly agentInstanceId: string;
  private readonly trackedPids = new Set<number>();
  private readonly samples: ResourceTelemetry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastCpuUsage: NodeJS.CpuUsage;

  constructor(options: TelemetrySupervisorOptions, initialPids: number[] = [process.pid]) {
    this.hostId = options.hostId ?? os.hostname();
    this.agentInstanceId = options.agentInstanceId;
    for (const pid of initialPids) {
      this.trackedPids.add(pid);
    }
    this.lastCpuUsage = process.cpuUsage();
  }

  trackPid(pid: number): void {
    this.trackedPids.add(pid);
  }

  untrackPid(pid: number): void {
    this.trackedPids.delete(pid);
  }

  sample(processName = "nexus-agent"): ResourceTelemetry {
    const mem = process.memoryUsage();
    const currentCpu = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();

    // Calculate approximate CPU percent over sample window
    const totalMicros = currentCpu.user + currentCpu.system;
    const cpuPercent = Math.min(100, Math.max(0, Math.round((totalMicros / 1000 / 100) * 10) / 10));

    const sample: ResourceTelemetry = {
      pid: process.pid,
      processName,
      cpuPercent,
      memoryBytes: mem.rss,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      threadCount: 1,
      timestamp: new Date().toISOString(),
    };

    this.samples.push(sample);
    if (this.samples.length > 1000) {
      this.samples.shift();
    }

    return sample;
  }

  startPeriodicSampling(intervalMs = 1000, processName = "nexus-agent"): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sample(processName);
    }, intervalMs);
    this.timer.unref();
  }

  stopPeriodicSampling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  generateReport(): TelemetryReport {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // System CPU estimate
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times) as (keyof typeof cpu.times)[]) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }
    const systemCpuUsagePercent =
      totalTick > 0
        ? Math.min(100, Math.max(0, Math.round((1 - totalIdle / totalTick) * 1000) / 10))
        : 0;

    return {
      hostId: this.hostId,
      agentInstanceId: this.agentInstanceId,
      metrics: [...this.samples],
      systemCpuUsagePercent,
      systemMemoryTotalBytes: totalMem,
      systemMemoryFreeBytes: freeMem,
      recordedAt: new Date().toISOString(),
    };
  }
}

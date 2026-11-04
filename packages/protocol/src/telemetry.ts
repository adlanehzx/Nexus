/**
 * NEXUS Unified Protocol - Resource Telemetry Schemas
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";

export const ResourceTelemetrySchema = z.object({
  pid: z.number().int().positive(),
  processName: z.string().min(1),
  cpuPercent: z.number().min(0).max(100),
  memoryBytes: z.number().int().nonnegative(),
  memoryLimitBytes: z.number().int().positive().optional(),
  ioReadBytes: z.number().int().nonnegative().default(0),
  ioWriteBytes: z.number().int().nonnegative().default(0),
  threadCount: z.number().int().positive().default(1),
  timestamp: z.string().datetime(),
});
export type ResourceTelemetry = z.infer<typeof ResourceTelemetrySchema>;

export const TelemetryReportSchema = z.object({
  hostId: z.string().min(1),
  agentInstanceId: z.string().min(1),
  metrics: z.array(ResourceTelemetrySchema),
  systemCpuUsagePercent: z.number().min(0).max(100),
  systemMemoryTotalBytes: z.number().int().positive(),
  systemMemoryFreeBytes: z.number().int().nonnegative(),
  recordedAt: z.string().datetime(),
});
export type TelemetryReport = z.infer<typeof TelemetryReportSchema>;

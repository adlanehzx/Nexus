import { z } from "zod";

/**
 * Health check probe contracts.
 *
 * Distinct probe endpoints:
 *  - **liveness** (`GET /health`): Is the process responsive? No external dependencies probed.
 *    Used by process managers/orchestrators for restarts.
 *  - **readiness** (`GET /api/v1/health`): Can the service process traffic?
 *    PostgreSQL and Redis dependencies are checked. Used for traffic routing.
 */

export const dependencyStatusSchema = z.object({
  status: z.enum(["up", "down"]),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});

export const livenessResponseSchema = z.object({
  status: z.literal("ok"),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});

export const readinessResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
  dependencies: z.object({
    database: dependencyStatusSchema,
    redis: dependencyStatusSchema,
  }),
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

/** Unified error envelope returned by the API. `code` is a stable contract. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    correlationId: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

import { z } from "zod";

/**
 * Contrats des sondes de santé.
 *
 * Deux sondes, deux usages distincts — les confondre est l'erreur classique qui
 * fait redémarrer un conteneur sain parce que sa base est momentanément lente :
 *
 *  - **liveness** (`GET /health`) : le processus répond-il ? Aucune dépendance
 *    n'est interrogée. C'est la sonde que l'orchestrateur utilise pour tuer.
 *  - **readiness** (`GET /api/v1/health`) : le service peut-il traiter du trafic ?
 *    PostgreSQL et Redis sont vérifiés. C'est la sonde qui retire de la rotation.
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

/** Forme d'erreur unique renvoyée par l'API. `code` est un contrat stable. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    correlationId: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

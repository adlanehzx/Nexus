import { z } from "zod";

export const osintTargetSchema = z.object({
  type: z.enum(["person", "username", "email", "domain", "organization", "ip", "phone", "url"]),
  value: z.string().trim().min(2).max(500),
});
export type OsintTarget = z.infer<typeof osintTargetSchema>;
export const osintCollectorSchema = z.enum([
  "search",
  "dns",
  "rdap",
  "crt",
  "username",
  "page",
  "correlation",
]);
export type OsintCollectorId = z.infer<typeof osintCollectorSchema>;
export const osintMissionInputSchema = z.object({
  title: z.string().trim().min(3).max(120),
  targets: z.array(osintTargetSchema).min(1).max(20),
  lawfulPurposeConfirmed: z.literal(true),
  config: z
    .object({
      maxDepth: z.number().int().min(0).max(4).default(1),
      maxIterations: z.number().int().min(1).max(100).default(20),
      maxDurationSeconds: z.number().int().min(10).max(3600).default(300),
      maxLlmTokens: z.number().int().min(256).max(100000).default(8000),
      collectors: z
        .array(osintCollectorSchema)
        .min(1)
        .default(["search", "dns", "rdap", "crt", "page", "correlation"]),
      sourceCategories: z
        .array(z.enum(["web", "registry", "social", "technical"]))
        .min(1)
        .default(["web", "registry", "technical"]),
      usernameSites: z
        .array(
          z
            .string()
            .url()
            .refine((v) => v.includes("{username}"), "Include {username} in each site URL"),
        )
        .max(20)
        .default(["https://github.com/{username}", "https://www.reddit.com/user/{username}/"]),
    })
    .default({
      maxDepth: 1,
      maxIterations: 20,
      maxDurationSeconds: 300,
      maxLlmTokens: 8000,
      collectors: ["search", "dns", "rdap", "crt", "page", "correlation"],
      sourceCategories: ["web", "registry", "technical"],
      usernameSites: ["https://github.com/{username}"],
    }),
});
export type OsintMissionInput = z.infer<typeof osintMissionInputSchema>;
export const osintMissionSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string(),
  caseId: z.string().uuid(),
  input: osintMissionInputSchema,
  status: z.enum(["queued", "running", "paused", "completed", "failed", "cancelled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  deadline: z.number(),
  iterations: z.number(),
  tokens: z.number(),
  plan: z.array(osintCollectorSchema),
  frontier: z.array(z.object({ target: osintTargetSchema, depth: z.number() })),
  visited: z.array(z.string()),
  timeline: z.array(z.object({ at: z.string(), action: z.string(), detail: z.string() })),
  report: z.string().optional(),
  reason: z.string().optional(),
});
export type OsintMission = z.infer<typeof osintMissionSchema>;

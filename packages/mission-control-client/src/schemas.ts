import { z } from "zod";

const identifier = z.string().uuid();
const money = z.union([z.string(), z.number()]);

export const missionControlHealthSchema = z.object({
  status: z.literal("ready"),
  worker_enabled: z.boolean(),
  worker_concurrency: z.number().int().positive(),
  scheduler_enabled: z.boolean().default(false),
  profiles: z.array(z.string()),
});

export const runtimeSettingsSchema = z.object({
  task_timeout_seconds: z.number().int().min(10).max(86_400),
  max_attempts: z.number().int().min(1).max(10),
  retry_delay_seconds: z.number().int().min(1).max(3_600),
  context_budget_chars: z.number().int().min(4_000).max(400_000),
  quality_review: z.boolean(),
  research_priority: z.array(z.string().min(1)).min(1).max(20),
  review_priority: z.array(z.string().min(1)).min(1).max(20),
  synthesis_priority: z.array(z.string().min(1)).min(1).max(20),
});

export const missionTaskInputSchema = z.object({
  key: z.string().trim().min(1).max(128),
  profile: z.string().trim().min(1).max(128),
  fallback_profiles: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
  instruction: z.string().trim().min(1).max(100_000),
  depends_on: z.array(z.string().trim().min(1).max(128)).max(100).default([]),
  timeout_seconds: z.number().int().min(10).max(86_400).default(1_800),
  max_attempts: z.number().int().min(1).max(10).default(2),
  retry_delay_seconds: z.number().int().min(1).max(3_600).default(10),
  context_budget_chars: z.number().int().min(4_000).max(400_000).default(60_000),
  /**
   * Exécutant de la tâche.
   *
   * Sans défaut, délibérément : le champ reste absent de la charge utile tant
   * qu'on ne le demande pas, et l'empreinte de contenu des plans purement ACP
   * est donc inchangée. Un défaut `"acp"` explicite modifierait l'empreinte de
   * tous les plans existants et casserait leur idempotence.
   */
  agent_kind: z.enum(["acp", "agent-core"]).optional(),
});

/**
 * Identité propriétaire signée transmise au moteur.
 *
 * Facultative, et pas par confort : les missions créées avant son introduction
 * n'en ont pas, et le moteur doit continuer de les porter. Ce qui l'exige, c'est
 * la délégation à Agent Core — refusée sans elle.
 */
export const missionOwnerSchema = z.object({
  user_id: z.string().trim().min(1).max(128),
  assertion: z.string().trim().min(1).max(4_096),
  /**
   * Expiration de l'assertion, en ISO 8601.
   *
   * Transmise pour que le moteur la connaisse sans savoir relire le jeton : il
   * n'a pas la clé, et c'est voulu. Facultative, comme le reste du bloc, pour
   * les missions d'avant l'identité signée.
   */
  expires_at: z.string().datetime().optional(),
});

export const submitMissionSchema = z.object({
  external_key: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(300),
  workspace: z.string().trim().min(1).max(4_096),
  tasks: z.array(missionTaskInputSchema).min(1).max(100),
  owner: missionOwnerSchema.optional(),
});

export const missionSubmissionSchema = z.object({
  mission_id: identifier,
  replayed: z.boolean(),
});

export const missionTaskSchema = z
  .object({
    id: identifier,
    mission_id: identifier,
    task_key: z.string(),
    ordinal: z.number().int().nonnegative(),
    profile_key: z.string(),
    state: z.string(),
    result_json: z.string().nullable(),
    error_json: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    depends_on: z.array(z.string()).default([]),
    attempts: z
      .array(
        z.object({
          id: identifier,
          attempt_no: z.number().int().positive(),
          state: z.string(),
          conversation_id: identifier,
          started_at: z.string(),
          updated_at: z.string(),
          finished_at: z.string().nullable(),
          error_json: z.string().nullable(),
        }),
      )
      .default([]),
  })
  .passthrough();

export const missionSnapshotSchema = z
  .object({
    id: identifier,
    external_key: z.string(),
    title: z.string(),
    workspace: z.string(),
    state: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    tasks: z.array(missionTaskSchema),
  })
  .passthrough();

export const missionSnapshotsSchema = z.object({
  missions: z.array(missionSnapshotSchema),
});

const schedulableMissionSchema = submitMissionSchema.omit({ owner: true });

export const createMissionScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    mission: schedulableMissionSchema,
    timezone: z.string().trim().min(1).max(100).default("UTC"),
    run_at: z.iso.datetime({ offset: true }).optional(),
    cron_expression: z.string().trim().min(1).max(100).optional(),
    catch_up_policy: z.enum(["skip", "latest", "all"]).default("latest"),
    max_catch_up: z.number().int().min(1).max(100).default(10),
    max_concurrency: z.number().int().min(1).max(32).default(1),
    misfire_grace_seconds: z.number().int().min(0).max(86_400).default(300),
  })
  .refine((value) => (value.run_at === undefined) !== (value.cron_expression === undefined), {
    message: "exactly one of run_at or cron_expression is required",
  });

export const missionScheduleSchema = z.object({
  id: identifier,
  name: z.string(),
  state: z.enum(["active", "paused", "completed"]),
  schedule_kind: z.enum(["one_shot", "cron"]),
  run_at: z.string().nullable(),
  cron_expression: z.string().nullable(),
  timezone: z.string(),
  catch_up_policy: z.enum(["skip", "latest", "all"]),
  max_catch_up: z.number().int().min(1).max(100),
  max_concurrency: z.number().int().min(1).max(32),
  misfire_grace_seconds: z.number().int().min(0).max(86_400),
  mission: schedulableMissionSchema,
  next_run_at: z.string().nullable(),
  last_scheduled_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const missionSchedulesSchema = z.object({
  schedules: z.array(missionScheduleSchema),
});

export const scheduleRunSchema = z.object({
  id: identifier,
  schedule_id: identifier,
  scheduled_for: z.string(),
  state: z.enum(["pending", "claimed", "submitted", "succeeded", "failed", "cancelled", "skipped"]),
  mission_id: identifier.nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

export const scheduleRunsSchema = z.object({ runs: z.array(scheduleRunSchema) });

export const configuredAgentSchema = z.object({
  key: z.string(),
  agent_profile_id: z.string(),
  running_tasks: z.number().int().nonnegative(),
  queued_tasks: z.number().int().nonnegative(),
  last_task_state: z.string().nullable(),
  status: z.enum([
    "available",
    "degraded",
    "cooldown",
    "quota_exhausted",
    "auth_required",
    "unknown",
  ]),
  cooldown_until: z.string().nullable(),
  remaining_5h_percent: z.number().int().min(0).max(100).nullable(),
  remaining_week_percent: z.number().int().min(0).max(100).nullable(),
  resets_5h_at: z.string().nullable(),
  resets_week_at: z.string().nullable(),
  usage_source: z.string(),
  consecutive_failures: z.number().int().nonnegative(),
  last_error_category: z.string().nullable(),
});

export const updateAgentHealthSchema = z.object({
  status: configuredAgentSchema.shape.status,
  cooldown_until: z.string().datetime({ offset: true }).nullable().optional(),
  remaining_5h_percent: z.number().int().min(0).max(100).nullable().optional(),
  remaining_week_percent: z.number().int().min(0).max(100).nullable().optional(),
  resets_5h_at: z.string().datetime({ offset: true }).nullable().optional(),
  resets_week_at: z.string().datetime({ offset: true }).nullable().optional(),
  usage_source: z.string().max(64).optional(),
});

export const availableAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  agent_kind: z.string(),
  revision: z.number().int().nullable().optional(),
  registered_as: z.string().nullable().optional(),
  command: z.string(),
  args: z.array(z.string()),
  model: z.string().nullable(),
  system_prompt: z.string().default(""),
  reasoning_effort: z
    .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    .nullable()
    .default(null),
  additional_dirs: z.array(z.string()).default([]),
  config_options: z.record(z.string(), z.string()).default({}),
  permission_policy: z.literal("workspace"),
});

export const agentRegistrySchema = z.object({
  worker_enabled: z.boolean(),
  configured: z.array(configuredAgentSchema),
  available: z.array(availableAgentSchema),
});

export const registerAgentSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  agent_profile_id: z.string().min(1).max(128),
});

export const createAgentSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  template_profile_id: z.string().min(1).max(128),
  model: z.string().max(200).nullable().optional(),
});

export const updateAgentProfileSchema = z.object({
  name: z.string().trim().min(1).max(64),
  command: z.string().trim().min(1).max(4_096),
  args: z.array(z.string().max(4_096)).max(64),
  model: z.string().max(200).nullable().optional(),
  system_prompt: z.string().max(32_000).optional(),
  reasoning_effort: z
    .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    .nullable()
    .optional(),
  additional_dirs: z.array(z.string().max(4_096)).max(32).optional(),
  config_options: z.record(z.string(), z.string()).optional(),
});

export const testAgentProfileSchema = z.object({
  workspace: z.string().trim().min(1).max(4_096),
  prompt: z.string().trim().min(1).max(8_000),
  timeout_seconds: z.number().int().min(10).max(600),
});

export const agentTestResultSchema = z.object({
  ok: z.literal(true),
  response: z.string(),
});

export const auditVerificationSchema = z.object({
  valid: z.boolean(),
  checked: z.number().int().nonnegative(),
  head: z.string().length(64).optional(),
  failed_sequence: z.number().int().positive().optional(),
});

export const paperAccountSchema = z
  .object({
    id: identifier,
    name: z.string(),
    currency: z.literal("EUR"),
    initial_balance_cents: z.number().int().positive(),
    cash_balance_cents: z.number().int().nonnegative(),
    realized_pnl_cents: z.number().int(),
    live_trading: z.literal(0),
    open_exposure_cents: z.number().int().nonnegative(),
    risk_policy: z.record(z.string(), z.unknown()),
    orders: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export const paperMarketSchema = z
  .object({
    id: identifier,
    question: z.string(),
    close_at: z.string(),
    venue: z.literal("paper"),
    state: z.enum(["open", "settled", "cancelled"]),
    winning_outcome: z.enum(["yes", "no"]).nullable(),
    latest_quote: z.record(z.string(), z.unknown()).nullable(),
  })
  .passthrough();

export const paperQuoteSchema = z.object({
  id: identifier,
  market_id: identifier,
  yes_price_ppm: z.number().int().min(1).max(999_999),
  liquidity_cents: z.number().int().nonnegative(),
});

export const researchMissionResponseSchema = z.object({
  mission_id: identifier,
  research_run_id: identifier,
  replayed: z.boolean(),
  mode: z.literal("paper_only"),
});

export const researchRunSchema = z
  .object({
    id: identifier,
    mission_id: identifier,
    account_id: identifier,
    market_id: identifier,
    state: z.enum(["running", "waiting_market_data", "executed", "abstained", "failed"]),
    decision_json: z.string().nullable(),
    paper_result_json: z.string().nullable(),
    error_code: z.string().nullable(),
    allowed_sources_json: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const paperAccountsSchema = z.object({ accounts: z.array(paperAccountSchema) });
export const paperMarketsSchema = z.object({ markets: z.array(paperMarketSchema) });
export const researchRunsSchema = z.object({ runs: z.array(researchRunSchema) });

export const createPaperAccountSchema = z.object({
  name: z.string().trim().min(1).max(100).default("Portefeuille NEXUS"),
  bankroll_eur: money.default("50.00"),
});

export const createPaperMarketSchema = z.object({
  question: z.string().trim().min(1).max(500),
  close_at: z.iso.datetime({ offset: true }),
});

export const addPaperQuoteSchema = z.object({
  yes_price: money,
  liquidity_eur: money,
  source_url: z.url({ protocol: /^https$/ }),
  observed_at: z.iso.datetime({ offset: true }),
});

export const submitResearchMissionSchema = z.object({
  objective: z.string().trim().min(1).max(2_000),
  question: z.string().trim().min(1).max(500),
  close_at: z.iso.datetime({ offset: true }),
  workspace: z.string().min(1).max(4_096),
  sources: z
    .array(z.url({ protocol: /^https$/ }))
    .min(1)
    .max(50),
  account_id: identifier,
  market_id: identifier,
});

export type MissionControlHealth = z.infer<typeof missionControlHealthSchema>;
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export type MissionTaskInput = z.input<typeof missionTaskInputSchema>;
export type SubmitMission = z.input<typeof submitMissionSchema>;
export type MissionSubmission = z.infer<typeof missionSubmissionSchema>;
export type MissionTask = z.infer<typeof missionTaskSchema>;
export type MissionSnapshot = z.infer<typeof missionSnapshotSchema>;
export type CreateMissionSchedule = z.input<typeof createMissionScheduleSchema>;
export type MissionSchedule = z.infer<typeof missionScheduleSchema>;
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;
export type ConfiguredAgent = z.infer<typeof configuredAgentSchema>;
export type AvailableAgent = z.infer<typeof availableAgentSchema>;
export type AgentRegistry = z.infer<typeof agentRegistrySchema>;
export type RegisterAgent = z.infer<typeof registerAgentSchema>;
export type CreateAgent = z.infer<typeof createAgentSchema>;
export type UpdateAgentProfile = z.infer<typeof updateAgentProfileSchema>;
export type TestAgentProfile = z.infer<typeof testAgentProfileSchema>;
export type AgentTestResult = z.infer<typeof agentTestResultSchema>;
export type UpdateAgentHealth = z.infer<typeof updateAgentHealthSchema>;
export type AuditVerification = z.infer<typeof auditVerificationSchema>;
export type PaperAccount = z.infer<typeof paperAccountSchema>;
export type PaperMarket = z.infer<typeof paperMarketSchema>;
export type PaperQuote = z.infer<typeof paperQuoteSchema>;
export type ResearchMissionResponse = z.infer<typeof researchMissionResponseSchema>;
export type ResearchRun = z.infer<typeof researchRunSchema>;
export type CreatePaperAccount = z.input<typeof createPaperAccountSchema>;
export type CreatePaperMarket = z.infer<typeof createPaperMarketSchema>;
export type AddPaperQuote = z.infer<typeof addPaperQuoteSchema>;
export type SubmitResearchMission = z.infer<typeof submitResearchMissionSchema>;

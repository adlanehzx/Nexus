import { z } from "zod";

const identifier = z.string().uuid();
const money = z.union([z.string(), z.number()]);

export const missionControlHealthSchema = z.object({
  status: z.literal("ready"),
  worker_enabled: z.boolean(),
  worker_concurrency: z.number().int().positive(),
  profiles: z.array(z.string()),
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
});

export const submitMissionSchema = z.object({
  external_key: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(300),
  workspace: z.string().trim().min(1).max(4_096),
  tasks: z.array(missionTaskInputSchema).min(1).max(100),
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
  })
  .passthrough();

export const missionSnapshotSchema = z
  .object({
    id: identifier,
    external_key: z.string(),
    title: z.string(),
    workspace: z.string(),
    state: z.string(),
    tasks: z.array(missionTaskSchema),
  })
  .passthrough();

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
export type MissionTaskInput = z.input<typeof missionTaskInputSchema>;
export type SubmitMission = z.input<typeof submitMissionSchema>;
export type MissionSubmission = z.infer<typeof missionSubmissionSchema>;
export type MissionTask = z.infer<typeof missionTaskSchema>;
export type MissionSnapshot = z.infer<typeof missionSnapshotSchema>;
export type ConfiguredAgent = z.infer<typeof configuredAgentSchema>;
export type AvailableAgent = z.infer<typeof availableAgentSchema>;
export type AgentRegistry = z.infer<typeof agentRegistrySchema>;
export type RegisterAgent = z.infer<typeof registerAgentSchema>;
export type CreateAgent = z.infer<typeof createAgentSchema>;
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

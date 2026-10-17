import { z } from "zod";

const identifier = z.string().uuid();
const money = z.union([z.string(), z.number()]);

export const missionControlHealthSchema = z.object({
  status: z.literal("ready"),
  worker_enabled: z.boolean(),
  worker_concurrency: z.number().int().positive(),
  profiles: z.array(z.string()),
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

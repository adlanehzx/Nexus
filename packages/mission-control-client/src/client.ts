import { AppError, type AppErrorOptions } from "@nexus/shared";
import type { z } from "zod";
import {
  addPaperQuoteSchema,
  auditVerificationSchema,
  createPaperAccountSchema,
  createPaperMarketSchema,
  missionControlHealthSchema,
  missionSnapshotSchema,
  missionSubmissionSchema,
  paperAccountSchema,
  paperAccountsSchema,
  paperMarketSchema,
  paperMarketsSchema,
  paperQuoteSchema,
  researchMissionResponseSchema,
  researchRunSchema,
  researchRunsSchema,
  submitResearchMissionSchema,
  submitMissionSchema,
  type AddPaperQuote,
  type AuditVerification,
  type CreatePaperAccount,
  type CreatePaperMarket,
  type MissionControlHealth,
  type MissionSnapshot,
  type MissionSubmission,
  type PaperAccount,
  type PaperMarket,
  type PaperQuote,
  type ResearchMissionResponse,
  type ResearchRun,
  type SubmitResearchMission,
  type SubmitMission,
} from "./schemas.js";

export class MissionControlClientError extends AppError {
  readonly code = "MISSION_CONTROL_UNAVAILABLE";
  readonly httpStatus = 502;
  override readonly retryable = true;

  constructor(options: AppErrorOptions) {
    super({ userMessage: "Le moteur multi-agents est indisponible.", ...options });
  }
}

export interface MissionControlClientOptions {
  baseUrl: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface MissionControlPort {
  health(signal?: AbortSignal): Promise<MissionControlHealth>;
  submitMission(
    input: SubmitMission,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<MissionSubmission>;
  getMission(id: string, signal?: AbortSignal): Promise<MissionSnapshot>;
  verifyAudit(signal?: AbortSignal): Promise<AuditVerification>;
  createPaperAccount(input: CreatePaperAccount, signal?: AbortSignal): Promise<PaperAccount>;
  getPaperAccount(id: string, signal?: AbortSignal): Promise<PaperAccount>;
  listPaperAccounts(limit?: number, signal?: AbortSignal): Promise<PaperAccount[]>;
  createPaperMarket(input: CreatePaperMarket, signal?: AbortSignal): Promise<PaperMarket>;
  getPaperMarket(id: string, signal?: AbortSignal): Promise<PaperMarket>;
  listPaperMarkets(limit?: number, signal?: AbortSignal): Promise<PaperMarket[]>;
  addPaperQuote(marketId: string, input: AddPaperQuote, signal?: AbortSignal): Promise<PaperQuote>;
  submitResearchMission(
    input: SubmitResearchMission,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ResearchMissionResponse>;
  getResearchRun(id: string, signal?: AbortSignal): Promise<ResearchRun>;
  listResearchRuns(limit?: number, signal?: AbortSignal): Promise<ResearchRun[]>;
}

export class MissionControlClient implements MissionControlPort {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: MissionControlClientOptions) {
    const url = validateBaseUrl(options.baseUrl);
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  health(signal?: AbortSignal): Promise<MissionControlHealth> {
    return this.#request("GET", "/v1/health/ready", missionControlHealthSchema, undefined, signal);
  }

  submitMission(
    input: SubmitMission,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<MissionSubmission> {
    if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      throw new TypeError("idempotencyKey must contain 1 to 128 characters");
    }
    return this.#request(
      "POST",
      "/v1/missions",
      missionSubmissionSchema,
      submitMissionSchema.parse(input),
      signal,
      { "idempotency-key": idempotencyKey },
    );
  }

  getMission(id: string, signal?: AbortSignal): Promise<MissionSnapshot> {
    return this.#request(
      "GET",
      `/v1/missions/${encodeURIComponent(id)}`,
      missionSnapshotSchema,
      undefined,
      signal,
    );
  }

  verifyAudit(signal?: AbortSignal): Promise<AuditVerification> {
    return this.#request(
      "GET",
      "/v1/paper/audit/verify",
      auditVerificationSchema,
      undefined,
      signal,
    );
  }

  createPaperAccount(input: CreatePaperAccount, signal?: AbortSignal): Promise<PaperAccount> {
    const body = createPaperAccountSchema.parse(input);
    return this.#request("POST", "/v1/paper/accounts", paperAccountSchema, body, signal);
  }

  getPaperAccount(id: string, signal?: AbortSignal): Promise<PaperAccount> {
    return this.#request(
      "GET",
      `/v1/paper/accounts/${encodeURIComponent(id)}`,
      paperAccountSchema,
      undefined,
      signal,
    );
  }

  async listPaperAccounts(limit = 50, signal?: AbortSignal): Promise<PaperAccount[]> {
    const result = await this.#request(
      "GET",
      `/v1/paper/accounts?limit=${String(boundedLimit(limit))}`,
      paperAccountsSchema,
      undefined,
      signal,
    );
    return result.accounts;
  }

  createPaperMarket(input: CreatePaperMarket, signal?: AbortSignal): Promise<PaperMarket> {
    const body = createPaperMarketSchema.parse(input);
    return this.#request("POST", "/v1/paper/markets", paperMarketSchema, body, signal);
  }

  getPaperMarket(id: string, signal?: AbortSignal): Promise<PaperMarket> {
    return this.#request(
      "GET",
      `/v1/paper/markets/${encodeURIComponent(id)}`,
      paperMarketSchema,
      undefined,
      signal,
    );
  }

  async listPaperMarkets(limit = 50, signal?: AbortSignal): Promise<PaperMarket[]> {
    const result = await this.#request(
      "GET",
      `/v1/paper/markets?limit=${String(boundedLimit(limit))}`,
      paperMarketsSchema,
      undefined,
      signal,
    );
    return result.markets;
  }

  addPaperQuote(marketId: string, input: AddPaperQuote, signal?: AbortSignal): Promise<PaperQuote> {
    const body = addPaperQuoteSchema.parse(input);
    return this.#request(
      "POST",
      `/v1/paper/markets/${encodeURIComponent(marketId)}/quotes`,
      paperQuoteSchema,
      body,
      signal,
    );
  }

  submitResearchMission(
    input: SubmitResearchMission,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ResearchMissionResponse> {
    if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      throw new TypeError("idempotencyKey must contain 1 to 128 characters");
    }
    const body = submitResearchMissionSchema.parse(input);
    return this.#request(
      "POST",
      "/v1/research-missions",
      researchMissionResponseSchema,
      body,
      signal,
      { "idempotency-key": idempotencyKey },
    );
  }

  getResearchRun(id: string, signal?: AbortSignal): Promise<ResearchRun> {
    return this.#request(
      "GET",
      `/v1/research-runs/${encodeURIComponent(id)}`,
      researchRunSchema,
      undefined,
      signal,
    );
  }

  async listResearchRuns(limit = 50, signal?: AbortSignal): Promise<ResearchRun[]> {
    const result = await this.#request(
      "GET",
      `/v1/research-runs?limit=${String(boundedLimit(limit))}`,
      researchRunsSchema,
      undefined,
      signal,
    );
    return result.runs;
  }

  async #request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
    } catch (cause) {
      throw new MissionControlClientError({
        message: `Mission Control request failed (${cause instanceof Error ? cause.name : "unknown"})`,
        cause,
      });
    }

    if (!response.ok) {
      // Le corps peut contenir des données d'agents : il ne traverse ni les logs
      // ni le message public. Le statut suffit à classer l'échec.
      throw new MissionControlClientError({
        message: `Mission Control returned HTTP ${String(response.status)}`,
        context: { status: response.status, path },
      });
    }

    try {
      return schema.parse(await response.json());
    } catch (cause) {
      throw new MissionControlClientError({
        message: "Mission Control returned an invalid contract",
        context: { path },
        cause,
      });
    }
  }
}

function validateBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new TypeError("Mission Control URL must be HTTP(S) and contain no credentials");
  }
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new TypeError("Plain HTTP is accepted only for loopback Mission Control URLs");
  }
  return url;
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new TypeError("limit must be an integer between 1 and 200");
  }
  return value;
}

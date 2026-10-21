import { AppError, type AppErrorOptions } from "@nexus/shared";
import type { z } from "zod";
import {
  addPaperQuoteSchema,
  agentRegistrySchema,
  auditVerificationSchema,
  createPaperAccountSchema,
  createPaperMarketSchema,
  createMissionScheduleSchema,
  createAgentSchema,
  updateAgentProfileSchema,
  testAgentProfileSchema,
  agentTestResultSchema,
  updateAgentHealthSchema,
  missionControlHealthSchema,
  runtimeSettingsSchema,
  missionSnapshotSchema,
  missionSnapshotsSchema,
  missionSubmissionSchema,
  missionScheduleSchema,
  missionSchedulesSchema,
  paperAccountSchema,
  paperAccountsSchema,
  paperMarketSchema,
  paperMarketsSchema,
  paperQuoteSchema,
  researchMissionResponseSchema,
  researchRunSchema,
  researchRunsSchema,
  scheduleRunsSchema,
  registerAgentSchema,
  submitResearchMissionSchema,
  submitMissionSchema,
  type AddPaperQuote,
  type AgentRegistry,
  type AuditVerification,
  type CreatePaperAccount,
  type CreatePaperMarket,
  type CreateMissionSchedule,
  type CreateAgent,
  type UpdateAgentProfile,
  type TestAgentProfile,
  type AgentTestResult,
  type UpdateAgentHealth,
  type MissionControlHealth,
  type RuntimeSettings,
  type MissionSnapshot,
  type MissionSubmission,
  type MissionSchedule,
  type PaperAccount,
  type PaperMarket,
  type PaperQuote,
  type ResearchMissionResponse,
  type ResearchRun,
  type ScheduleRun,
  type RegisterAgent,
  type SubmitResearchMission,
  type SubmitMission,
} from "./schemas.js";

export class MissionControlClientError extends AppError {
  readonly code = "MISSION_CONTROL_UNAVAILABLE";
  readonly httpStatus = 502;
  override readonly retryable = true;

  constructor(options: AppErrorOptions) {
    super({ userMessage: "The multi-agent engine is unavailable.", ...options });
  }
}

export interface MissionControlClientOptions {
  baseUrl: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Provides the service token to present to the engine.
   *
   * A function rather than a value: a service token lives for two minutes, so
   * it must be issued per request. Caching a string at client instantiation
   * would make it expire by the third call.
   *
   * Optional, and its absence has a clear effect: requests are sent without
   * identity, and an engine configured to require one will reject them. This is
   * the desired behavior — an explicit rejection is better than false security.
   */
  serviceToken?: () => string;
}

export interface MissionControlPort {
  health(signal?: AbortSignal): Promise<MissionControlHealth>;
  settings(signal?: AbortSignal): Promise<RuntimeSettings>;
  updateSettings(input: RuntimeSettings, signal?: AbortSignal): Promise<RuntimeSettings>;
  submitMission(
    input: SubmitMission,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<MissionSubmission>;
  getMission(id: string, signal?: AbortSignal): Promise<MissionSnapshot>;
  listMissions(
    limit?: number,
    externalPrefix?: string,
    signal?: AbortSignal,
  ): Promise<MissionSnapshot[]>;
  createSchedule(input: CreateMissionSchedule, signal?: AbortSignal): Promise<MissionSchedule>;
  getSchedule(id: string, signal?: AbortSignal): Promise<MissionSchedule>;
  listSchedules(limit?: number, signal?: AbortSignal): Promise<MissionSchedule[]>;
  listScheduleRuns(id: string, limit?: number, signal?: AbortSignal): Promise<ScheduleRun[]>;
  pauseSchedule(id: string, signal?: AbortSignal): Promise<MissionSchedule>;
  resumeSchedule(id: string, signal?: AbortSignal): Promise<MissionSchedule>;
  agents(signal?: AbortSignal): Promise<AgentRegistry>;
  registerAgent(input: RegisterAgent, signal?: AbortSignal): Promise<AgentRegistry>;
  createAgent(input: CreateAgent, signal?: AbortSignal): Promise<AgentRegistry>;
  updateAgentProfile(
    id: string,
    input: UpdateAgentProfile,
    signal?: AbortSignal,
  ): Promise<AgentRegistry>;
  disableAgent(key: string, signal?: AbortSignal): Promise<AgentRegistry>;
  testAgentProfile(
    id: string,
    input: TestAgentProfile,
    signal?: AbortSignal,
  ): Promise<AgentTestResult>;
  updateAgentHealth(
    key: string,
    input: UpdateAgentHealth,
    signal?: AbortSignal,
  ): Promise<AgentRegistry>;
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
  readonly #serviceToken: (() => string) | undefined;

  constructor(options: MissionControlClientOptions) {
    const url = validateBaseUrl(options.baseUrl);
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#serviceToken = options.serviceToken;
  }

  health(signal?: AbortSignal): Promise<MissionControlHealth> {
    return this.#request("GET", "/v1/health/ready", missionControlHealthSchema, undefined, signal);
  }

  settings(signal?: AbortSignal): Promise<RuntimeSettings> {
    return this.#request("GET", "/v1/settings", runtimeSettingsSchema, undefined, signal);
  }

  updateSettings(input: RuntimeSettings, signal?: AbortSignal): Promise<RuntimeSettings> {
    return this.#request(
      "PUT",
      "/v1/settings",
      runtimeSettingsSchema,
      runtimeSettingsSchema.parse(input),
      signal,
    );
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

  async listMissions(
    limit = 50,
    externalPrefix?: string,
    signal?: AbortSignal,
  ): Promise<MissionSnapshot[]> {
    const query = new URLSearchParams({ limit: String(boundedLimit(limit)) });
    if (externalPrefix !== undefined) query.set("external_prefix", externalPrefix);
    const result = await this.#request(
      "GET",
      `/v1/missions?${query.toString()}`,
      missionSnapshotsSchema,
      undefined,
      signal,
    );
    return result.missions;
  }

  createSchedule(input: CreateMissionSchedule, signal?: AbortSignal): Promise<MissionSchedule> {
    return this.#request(
      "POST",
      "/v1/schedules",
      missionScheduleSchema,
      createMissionScheduleSchema.parse(input),
      signal,
    );
  }

  getSchedule(id: string, signal?: AbortSignal): Promise<MissionSchedule> {
    return this.#request(
      "GET",
      `/v1/schedules/${encodeURIComponent(id)}`,
      missionScheduleSchema,
      undefined,
      signal,
    );
  }

  async listSchedules(limit = 50, signal?: AbortSignal): Promise<MissionSchedule[]> {
    const result = await this.#request(
      "GET",
      `/v1/schedules?limit=${String(boundedLimit(limit))}`,
      missionSchedulesSchema,
      undefined,
      signal,
    );
    return result.schedules;
  }

  async listScheduleRuns(id: string, limit = 100, signal?: AbortSignal): Promise<ScheduleRun[]> {
    const result = await this.#request(
      "GET",
      `/v1/schedules/${encodeURIComponent(id)}/runs?limit=${String(boundedLimit(limit, 500))}`,
      scheduleRunsSchema,
      undefined,
      signal,
    );
    return result.runs;
  }

  pauseSchedule(id: string, signal?: AbortSignal): Promise<MissionSchedule> {
    return this.#request(
      "POST",
      `/v1/schedules/${encodeURIComponent(id)}/pause`,
      missionScheduleSchema,
      undefined,
      signal,
    );
  }

  resumeSchedule(id: string, signal?: AbortSignal): Promise<MissionSchedule> {
    return this.#request(
      "POST",
      `/v1/schedules/${encodeURIComponent(id)}/resume`,
      missionScheduleSchema,
      undefined,
      signal,
    );
  }

  agents(signal?: AbortSignal): Promise<AgentRegistry> {
    return this.#request("GET", "/v1/agents", agentRegistrySchema, undefined, signal);
  }

  registerAgent(input: RegisterAgent, signal?: AbortSignal): Promise<AgentRegistry> {
    return this.#request(
      "POST",
      "/v1/agents",
      agentRegistrySchema,
      registerAgentSchema.parse(input),
      signal,
    );
  }

  createAgent(input: CreateAgent, signal?: AbortSignal): Promise<AgentRegistry> {
    return this.#request(
      "POST",
      "/v1/agents/create",
      agentRegistrySchema,
      createAgentSchema.parse(input),
      signal,
    );
  }

  updateAgentProfile(
    id: string,
    input: UpdateAgentProfile,
    signal?: AbortSignal,
  ): Promise<AgentRegistry> {
    return this.#request(
      "PUT",
      `/v1/agents/profiles/${encodeURIComponent(id)}`,
      agentRegistrySchema,
      updateAgentProfileSchema.parse(input),
      signal,
    );
  }

  disableAgent(key: string, signal?: AbortSignal): Promise<AgentRegistry> {
    return this.#request(
      "DELETE",
      `/v1/agents/${encodeURIComponent(key)}`,
      agentRegistrySchema,
      undefined,
      signal,
    );
  }

  testAgentProfile(
    id: string,
    input: TestAgentProfile,
    signal?: AbortSignal,
  ): Promise<AgentTestResult> {
    return this.#request(
      "POST",
      `/v1/agents/profiles/${encodeURIComponent(id)}/test`,
      agentTestResultSchema,
      testAgentProfileSchema.parse(input),
      signal,
      {},
      input.timeout_seconds * 1_000 + 5_000,
    );
  }

  updateAgentHealth(
    key: string,
    input: UpdateAgentHealth,
    signal?: AbortSignal,
  ): Promise<AgentRegistry> {
    return this.#request(
      "PATCH",
      `/v1/agents/${encodeURIComponent(key)}/health`,
      agentRegistrySchema,
      updateAgentHealthSchema.parse(input),
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
    timeoutMs = this.#timeoutMs,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          // Issued here at request time for the reason described in
          // `serviceToken`: its lifespan is measured in minutes.
          ...(this.#serviceToken === undefined
            ? {}
            : { authorization: `Bearer ${this.#serviceToken()}` }),
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
      // Body may contain agent data: it should not leak into logs or
      // public messages. HTTP status code is sufficient to categorize the failure.
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

function boundedLimit(value: number, maximum = 200): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`limit must be an integer between 1 and ${String(maximum)}`);
  }
  return value;
}

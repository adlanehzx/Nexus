import type { Page, SessionManager } from "@nexus/client-core";
import type {
  AgentRegistry,
  AgentRunResult,
  AgentRunRow,
  ConnectionEntry,
  ConversationSummary,
  DeviceRow,
  LlmEnginesSection,
  McpConfiguration,
  McpSection,
  MissionControlSection,
  OrchestratedMission,
  Overview,
  PauseState,
  ProviderAccount,
  ProviderDriver,
  ProviderModel,
  PushRegistration,
  SatelliteCommandAccepted,
  SatelliteView,
  TaskRow,
  ToolRow,
  UsageReport,
  UserProfile,
  VisualControlStatus,
} from "./api-types.js";
import { ApiError } from "./errors.js";

/**
 * REST routes specific to the mobile screens.
 *
 * Complements `ApiClient` from `@nexus/client-core`, which remains the owner of
 * devices, tasks, memory and notifications; nothing here is duplicated from it.
 * Token handling stays in `SessionManager.authorizedRequest`.
 *
 * Unlike `ApiClient`, failures carry the HTTP status: a screen has to tell an
 * administrator-only section apart from an outage.
 */

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** An agent run is synchronous on the core and may legitimately take minutes. */
const AGENT_RUN_TIMEOUT_MS = 5 * 60_000;

/** Upper bound of history pages read when opening a conversation. */
const MAX_HISTORY_PAGES = 5;

const segment = encodeURIComponent;

export type RequestTransport = Pick<SessionManager, "authorizedRequest">;

export class MobileApi {
  readonly #session: RequestTransport;

  constructor(session: RequestTransport) {
    this.#session = session;
  }

  // ── Conversations ───────────────────────────────────────────────────────

  async listConversations(limit = 50): Promise<ConversationSummary[]> {
    return (await this.#page<ConversationSummary>(`/api/v1/conversations?limit=${limit}`)).items;
  }

  createConversation(title: string): Promise<ConversationSummary> {
    return this.#call("POST", "/api/v1/conversations", { title: title.slice(0, 200) });
  }

  archiveConversation(id: string): Promise<ConversationSummary> {
    return this.#call("POST", `/api/v1/conversations/${segment(id)}/archive`);
  }

  /**
   * The conversation's history, oldest first.
   *
   * The route pages forward from the oldest message, so the recent end is only
   * reachable by walking the cursor. The walk is bounded: a very long
   * conversation shows its first pages rather than stalling a phone.
   */
  async listAllMessages<T>(conversationId: string): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const query: string = cursor === null ? "" : `&cursor=${segment(cursor)}`;
      const result: Page<T> = await this.#page<T>(
        `/api/v1/conversations/${segment(conversationId)}/messages?limit=100${query}`,
      );
      items.push(...result.items);
      cursor = result.nextCursor;
      if (cursor === null) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  /** Runs the agent on a conversation. The core persists both messages itself. */
  runAgent(conversationId: string, message: string): Promise<AgentRunResult> {
    return this.#call(
      "POST",
      "/api/v1/agent-core/runs",
      { conversationId, message },
      AGENT_RUN_TIMEOUT_MS,
    );
  }

  getRun(runId: string): Promise<AgentRunResult> {
    return this.#call("GET", `/api/v1/agent-core/runs/${segment(runId)}`);
  }

  /** Answers the confirmation a run stopped on, which resumes the run. */
  answerRunConfirmation(
    runId: string,
    decision: "approved" | "rejected",
    confirmationId?: string,
  ): Promise<AgentRunResult> {
    return this.#call(
      "POST",
      `/api/v1/agent-core/runs/${segment(runId)}/confirmation`,
      { decision, ...(confirmationId === undefined ? {} : { confirmationId }) },
      AGENT_RUN_TIMEOUT_MS,
    );
  }

  async cancelRun(runId: string): Promise<boolean> {
    const result = await this.#call<{ cancelled: boolean }>(
      "POST",
      `/api/v1/agent-core/runs/${segment(runId)}/cancel`,
    );
    return result.cancelled;
  }

  async listRuns(limit = 50): Promise<AgentRunRow[]> {
    return (
      await this.#call<{ runs: AgentRunRow[] }>("GET", `/api/v1/dashboard/runs?limit=${limit}`)
    ).runs;
  }

  getRunDetail(runId: string): Promise<AgentRunRow> {
    return this.#call("GET", `/api/v1/dashboard/runs/${segment(runId)}`);
  }

  replayRun(runId: string): Promise<AgentRunRow> {
    return this.#call("POST", `/api/v1/dashboard/runs/${segment(runId)}/replay`, {});
  }

  agentRegistry(): Promise<AgentRegistry> {
    return this.#call("GET", "/api/v1/orchestrator/agents");
  }

  overview(): Promise<Overview> {
    return this.#call("GET", "/api/v1/dashboard/overview");
  }

  // ── Mission Control ─────────────────────────────────────────────────────

  missionControl(): Promise<MissionControlSection> {
    return this.#call("GET", "/api/v1/dashboard/mission-control");
  }

  submitMission(message: string, timezone: string): Promise<OrchestratedMission> {
    return this.#call("POST", "/api/v1/orchestrator/messages", { message, timezone });
  }

  getMission(missionId: string): Promise<OrchestratedMission> {
    return this.#call("GET", `/api/v1/orchestrator/missions/${segment(missionId)}`);
  }

  setSchedulePaused(scheduleId: string, paused: boolean): Promise<unknown> {
    const action = paused ? "pause" : "resume";
    return this.#call("POST", `/api/v1/mission-control/schedules/${segment(scheduleId)}/${action}`);
  }

  async listTasks(limit = 100): Promise<TaskRow[]> {
    return (await this.#call<{ tasks: TaskRow[] }>("GET", `/api/v1/dashboard/tasks?limit=${limit}`))
      .tasks;
  }

  // ── Usage ───────────────────────────────────────────────────────────────

  usage(days: number): Promise<UsageReport> {
    return this.#call("GET", `/api/v1/usage?days=${days}`);
  }

  async providerAccounts(): Promise<ProviderAccount[]> {
    return (
      await this.#call<{ accounts: ProviderAccount[] }>("GET", "/api/v1/orchestrator/accounts")
    ).accounts;
  }

  llmEngines(): Promise<LlmEnginesSection> {
    return this.#call("GET", "/api/v1/dashboard/llm/engines");
  }

  /** Replaces the routing configuration. The route takes the whole document. */
  saveLlmRouting(config: Pick<LlmEnginesSection, "enabled" | "preferLocal" | "engines">) {
    return this.#call("PUT", "/api/v1/dashboard/llm/engines", {
      enabled: config.enabled,
      preferLocal: config.preferLocal,
      engines: config.engines,
    });
  }

  async providers(): Promise<ProviderDriver[]> {
    return (await this.#call<{ providers: ProviderDriver[] }>("GET", "/api/v1/providers"))
      .providers;
  }

  async models(): Promise<ProviderModel[]> {
    return (await this.#call<{ models: ProviderModel[] }>("GET", "/api/v1/providers/models"))
      .models;
  }

  // ── MCP ─────────────────────────────────────────────────────────────────

  mcp(): Promise<McpSection> {
    return this.#call("GET", "/api/v1/dashboard/mcp");
  }

  saveMcp(config: McpConfiguration): Promise<unknown> {
    return this.#call("PUT", `/api/v1/dashboard/mcp/servers/${segment(config.name)}`, config);
  }

  reconnectMcp(name: string): Promise<unknown> {
    return this.#call("POST", `/api/v1/dashboard/mcp/servers/${segment(name)}/reconnect`);
  }

  removeMcp(name: string): Promise<unknown> {
    return this.#call("DELETE", `/api/v1/dashboard/mcp/servers/${segment(name)}`);
  }

  async tools(): Promise<ToolRow[]> {
    return (await this.#call<{ tools: ToolRow[] }>("GET", "/api/v1/dashboard/tools")).tools;
  }

  // ── Devices and remote control ──────────────────────────────────────────

  async fleet(): Promise<DeviceRow[]> {
    return (await this.#call<{ devices: DeviceRow[] }>("GET", "/api/v1/dashboard/devices")).devices;
  }

  getDevice(deviceId: string): Promise<DeviceRow> {
    return this.#call("GET", `/api/v1/dashboard/devices/${segment(deviceId)}`);
  }

  disconnectDevice(deviceId: string): Promise<{ closed: number }> {
    return this.#call("DELETE", `/api/v1/devices/${segment(deviceId)}/sessions`);
  }

  /** Single-use ticket. `payload` is shown once, for the new device to consume. */
  createPairingTicket(
    label: string,
  ): Promise<{ id: string; token: string; payload: string; expiresAt: string }> {
    return this.#call("POST", "/api/v1/devices/pairing-tickets", { label });
  }

  async satellites(): Promise<SatelliteView[]> {
    return (await this.#call<{ satellites: SatelliteView[] }>("GET", "/api/v1/satellites"))
      .satellites;
  }

  sendSatelliteCommand(
    deviceId: string,
    command: string,
    params: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<SatelliteCommandAccepted> {
    return this.#call("POST", `/api/v1/satellites/${segment(deviceId)}/commands`, {
      command,
      params,
      idempotencyKey,
    });
  }

  pauseState(): Promise<PauseState> {
    return this.#call("GET", "/api/v1/pause");
  }

  setPaused(paused: boolean, reason?: string): Promise<PauseState> {
    return this.#call("POST", "/api/v1/pause", {
      paused,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  visualControl(): Promise<VisualControlStatus> {
    return this.#call("GET", "/api/v1/dashboard/visual-control/status");
  }

  setVisualControlPaused(paused: boolean): Promise<{ paused: boolean }> {
    return this.#call("POST", "/api/v1/dashboard/visual-control/pause", { paused });
  }

  // ── Account ─────────────────────────────────────────────────────────────

  me(): Promise<UserProfile> {
    return this.#call("GET", "/api/v1/users/me");
  }

  async permissions(): Promise<string[]> {
    return (await this.#call<{ permissions: string[] }>("GET", "/api/v1/users/me/permissions"))
      .permissions;
  }

  /** Closes every session of the account, on every device. */
  logoutEverywhere(): Promise<unknown> {
    return this.#call("POST", "/api/v1/auth/logout-all");
  }

  async connections(): Promise<ConnectionEntry[]> {
    return (await this.#call<{ connections: ConnectionEntry[] }>("GET", "/api/v1/connections"))
      .connections;
  }

  testConnection(providerId: string): Promise<ConnectionEntry> {
    return this.#call("POST", `/api/v1/connections/${segment(providerId)}/test`);
  }

  /** Throws an `ApiError` with status 404 on a core without the route. */
  registerPushToken(deviceId: string, registration: PushRegistration): Promise<unknown> {
    return this.#call("POST", `/api/v1/devices/${segment(deviceId)}/push-token`, registration);
  }

  unregisterPushToken(deviceId: string): Promise<unknown> {
    return this.#call("DELETE", `/api/v1/devices/${segment(deviceId)}/push-token`);
  }

  // ── Transport ───────────────────────────────────────────────────────────

  async #page<T>(path: string): Promise<Page<T>> {
    const response = await this.#session.authorizedRequest({ method: "GET", path });
    const body = bodyOrThrow(response.status, response.body) as {
      data: T[];
      meta?: { nextCursor?: string | null; total?: number };
    };
    return {
      items: body.data,
      nextCursor: body.meta?.nextCursor ?? null,
      total: body.meta?.total ?? body.data.length,
    };
  }

  async #call<T>(method: Method, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const controller = timeoutMs === undefined ? undefined : new AbortController();
    const timer =
      controller === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, timeoutMs);

    try {
      const response = await this.#session.authorizedRequest({
        method,
        path,
        ...(body === undefined ? {} : { body }),
        ...(controller === undefined ? {} : { signal: controller.signal }),
      });
      return unwrap<T>(bodyOrThrow(response.status, response.body));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * Most routes answer `{ data }`; the provider catalogue answers bare objects.
 */
function unwrap<T>(body: unknown): T {
  if (body !== null && typeof body === "object" && "data" in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

function bodyOrThrow(status: number, body: unknown): unknown {
  if (status >= 200 && status < 300) return body;
  const { message, code } = errorOf(body);
  throw new ApiError(status, message ?? "The request failed.", code);
}

/** Error envelopes in the wild: `{ error: {...} }`, and `{ code, message }` from `/usage`. */
function errorOf(body: unknown): { message?: string; code?: string } {
  if (body === null || typeof body !== "object") return {};
  const source = "error" in body && typeof body.error === "object" ? body.error : body;
  if (source === null || typeof source !== "object") return {};
  const { message, code } = source as { message?: unknown; code?: unknown };
  return {
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof code === "string" ? { code } : {}),
  };
}

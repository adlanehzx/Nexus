import { FetchHttpClient, SessionManager, VolatileStorage } from "@nexus/client-core";
import type { HttpClient } from "@nexus/client-core";

/**
 * Le client du tableau de bord.
 *
 * Il réutilise `SessionManager` de `@nexus/client-core` — même connexion, même
 * rafraîchissement transparent, même trousseau — parce qu'un second mécanisme de
 * session serait un second endroit où se tromper sur l'expiration d'un jeton.
 *
 * Les mutations sont volontairement centralisées ici. Elles passent toutes par
 * la session administrateur, les validations du cœur et, pour les opérations
 * irréversibles, une confirmation explicite dans l'interface.
 *
 * Les types décrivent ce que le serveur envoie **réellement** — c'est-à-dire ce
 * qu'il a le droit d'envoyer. On n'y trouvera ni transcript, ni bloc de
 * raisonnement : la frontière est tenue côté serveur, et ces types en sont le
 * reflet, pas la garantie.
 */

export interface HealthEntry {
  name: string;
  level: "ok" | "degraded" | "down" | "unconfigured";
  detail: string;
}

export interface ActivityEntry {
  at: string;
  kind: "task" | "run" | "security" | "log";
  summary: string;
  level: "info" | "warning" | "error";
}

export interface Overview {
  at: string;
  devices: { total: number; online: number; degraded: number; revoked: number };
  workers: { total: number; connected: number; accepting: number; busy: number };
  tasks: { total: number; running: number; succeeded: number; failed: number; cancelled: number };
  agentRuns: { total: number; running: number; failed: number; waitingForConfirmation: number };
  notifications: { unread: number };
  security: { eventsRetained: number; byKind: Record<string, number> };
  health: HealthEntry[];
  recentActivity: ActivityEntry[];
}

export interface DeviceRow {
  id: string;
  name: string;
  role: string;
  type: string;
  platform: string;
  status: string;
  trust: string;
  authenticated: boolean;
  capabilities: { name: string; enabled: boolean; version: string; description: string }[];
  grantedPermissions: string[];
  lastHeartbeatAt: string | null;
  health: {
    activeTasks: number;
    maxConcurrentTasks: number;
    cpuLoad: number | null;
    memoryFreeMb: number | null;
    diskFreeMb: number | null;
    batteryPercent: number | null;
    onBattery: boolean | null;
    latencyMs: number | null;
    reportedAt: string | null;
  };
  pairedAt: string;
  revokedAt: string | null;
  agentVersion: string | null;
}

export interface WorkerRow extends DeviceRow {
  connected: boolean;
  acceptingTasks: boolean;
}

export interface TaskStepRow {
  id: string;
  description: string;
  tool: string;
  requiredCapabilities: string[];
  status: string;
  selectedDeviceId: string | null;
  selectedDeviceName: string | null;
  riskLevel: string;
  error: { code: string; message: string } | null;
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  originClientDeviceId: string;
  correlationId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progressPercent: number;
  steps: TaskStepRow[];
}

export interface TaskDetail extends TaskRow {
  executions: {
    id: string;
    stepId: string;
    deviceId: string;
    deviceName: string | null;
    status: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    result: unknown;
    error: { code: string; message: string } | null;
  }[];
}

/**
 * Un run, tel que le serveur le rend.
 *
 * À lire pour ce qui **n'y est pas** : ni `messages`, ni `providerBlocks`, ni
 * transcript. Seulement statut, action, outil, progression, résultat, erreur,
 * métriques.
 */
export interface AgentRunRow {
  runId: string;
  userId: string;
  conversationId: string;
  correlationId: string;
  status: string;
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  iterations: number;
  response: string | null;
  tools: {
    callId: string;
    tool: string;
    riskLevel: string;
    status: string;
    durationMs: number;
    attempts: number;
    action: string;
    errorCode: string | null;
  }[];
  errors: { at: string; code: string; message: string; iteration: number }[];
  metrics: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    toolCalls: number;
    failedToolCalls: number;
  };
}

export interface ToolRow {
  name: string;
  description: string;
  version: string;
  riskLevel: string;
  requiredPermissions: string[];
  allowed: boolean;
}

export interface McpSection {
  configured: boolean;
  servers: {
    name: string;
    status: string;
    toolCount: number;
    lastError: string | null;
    consecutiveFailures: number;
    reconnectAttempts: number;
    circuitOpenUntil: string | null;
    serverInfo: { name: string; version: string } | null;
  }[];
}

export interface BrowserSection {
  configured: boolean;
  reachable: boolean;
  detail: string;
  health: unknown;
}

export interface MissionControlSection {
  configured: boolean;
  reachable: boolean;
  detail: string;
  health: null | {
    status: "ready";
    worker_enabled: boolean;
    worker_concurrency: number;
    profiles: string[];
  };
  audit: null | {
    valid: boolean;
    checked: number;
    head?: string;
    failed_sequence?: number;
  };
  accounts: {
    id: string;
    name: string;
    currency: "EUR";
    initial_balance_cents: number;
    cash_balance_cents: number;
    realized_pnl_cents: number;
    open_exposure_cents: number;
    live_trading: 0;
  }[];
  markets: {
    id: string;
    question: string;
    close_at: string;
    state: "open" | "settled" | "cancelled";
  }[];
  recent_runs: {
    id: string;
    mission_id: string;
    account_id: string;
    market_id: string;
    state: "running" | "waiting_market_data" | "executed" | "abstained" | "failed";
    error_code: string | null;
    created_at: string;
    updated_at: string;
  }[];
}

export interface OrchestratedMission {
  missionId: string;
  title: string;
  state: string;
  profiles: string[];
  completedTasks: number;
  totalTasks: number;
  response: string | null;
  error: string | null;
}

export interface AgentRegistry {
  worker_enabled: boolean;
  configured: {
    key: string;
    agent_profile_id: string;
    running_tasks: number;
    queued_tasks: number;
    last_task_state: string | null;
    status: "available" | "degraded" | "cooldown" | "quota_exhausted" | "auth_required" | "unknown";
    cooldown_until: string | null;
    remaining_5h_percent: number | null;
    remaining_week_percent: number | null;
    resets_5h_at: string | null;
    resets_week_at: string | null;
    usage_source: string;
    consecutive_failures: number;
    last_error_category: string | null;
  }[];
  available: {
    id: string;
    name: string;
    agent_kind: string;
    revision?: number | null;
    registered_as?: string | null;
    command: string;
    args: string[];
    model: string | null;
    permission_policy: "workspace";
  }[];
}

export interface RuntimeSettings {
  task_timeout_seconds: number;
  max_attempts: number;
  retry_delay_seconds: number;
  context_budget_chars: number;
  quality_review: boolean;
  research_priority: string[];
  review_priority: string[];
  synthesis_priority: string[];
}

export interface MemorySection {
  total: number;
  byLayer: Record<string, number>;
  byOrigin: Record<string, number>;
  bySensitivity: Record<string, number>;
  recent: { id: string; content: string; layer: string; origin: string; createdAt: string }[];
}

export interface NotificationSection {
  unread: number;
  notifications: {
    id: string;
    title: string;
    body: string;
    severity: string;
    readAt: string | null;
    createdAt: string;
  }[];
}

export interface SecuritySection {
  events: {
    at: string;
    kind: string;
    userId: string | null;
    summary: string;
    context: Record<string, unknown>;
  }[];
  byKind: Record<string, number>;
  trust: { trusted: number; pending: number; revoked: number };
  permissions: string[];
}

export interface LogSection {
  retained: number;
  entries: {
    at: string;
    level: string;
    message: string;
    correlationId: string | null;
    context: Record<string, unknown>;
  }[];
}

export class ForbiddenError extends Error {
  readonly code = "DASHBOARD_FORBIDDEN";
}

export class DashboardApi {
  readonly #session: SessionManager;

  constructor(session: SessionManager) {
    this.#session = session;
  }

  overview(): Promise<Overview> {
    return this.#get("/api/v1/dashboard/overview");
  }

  devices(): Promise<{ devices: DeviceRow[] }> {
    return this.#get("/api/v1/dashboard/devices");
  }

  workers(): Promise<{ workers: WorkerRow[] }> {
    return this.#get("/api/v1/dashboard/workers");
  }

  tasks(): Promise<{ tasks: TaskRow[] }> {
    return this.#get("/api/v1/dashboard/tasks?limit=100");
  }

  task(taskId: string): Promise<TaskDetail> {
    return this.#get(`/api/v1/dashboard/tasks/${taskId}`);
  }

  cancelTask(taskId: string): Promise<{ cancelled: boolean }> {
    return this.#request("POST", `/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      reason: "annulé depuis la supervision NEXUS",
    });
  }

  trustDevice(deviceId: string): Promise<unknown> {
    return this.#request("POST", `/api/v1/devices/${encodeURIComponent(deviceId)}/trust`);
  }

  revokeDevice(deviceId: string): Promise<unknown> {
    return this.#request("POST", `/api/v1/devices/${encodeURIComponent(deviceId)}/revoke`);
  }

  updateDevicePermissions(deviceId: string, grantedPermissions: string[]): Promise<unknown> {
    return this.#request(
      "PATCH",
      `/api/v1/devices/${encodeURIComponent(deviceId)}/permissions`,
      { grantedPermissions },
    );
  }

  runs(): Promise<{ runs: AgentRunRow[] }> {
    return this.#get("/api/v1/dashboard/runs?limit=100");
  }

  tools(): Promise<{ tools: ToolRow[] }> {
    return this.#get("/api/v1/dashboard/tools");
  }

  mcp(): Promise<McpSection> {
    return this.#get("/api/v1/dashboard/mcp");
  }

  browser(): Promise<BrowserSection> {
    return this.#get("/api/v1/dashboard/browser");
  }

  missionControl(): Promise<MissionControlSection> {
    return this.#get("/api/v1/dashboard/mission-control");
  }

  sendToNexus(message: string): Promise<OrchestratedMission> {
    return this.#request("POST", "/api/v1/orchestrator/messages", { message });
  }

  nexusMission(missionId: string): Promise<OrchestratedMission> {
    return this.#get(`/api/v1/orchestrator/missions/${encodeURIComponent(missionId)}`);
  }

  agents(): Promise<AgentRegistry> {
    return this.#get("/api/v1/orchestrator/agents");
  }

  runtimeSettings(): Promise<RuntimeSettings> {
    return this.#get("/api/v1/orchestrator/settings");
  }

  updateRuntimeSettings(input: RuntimeSettings): Promise<RuntimeSettings> {
    return this.#request("PUT", "/api/v1/orchestrator/settings", input);
  }

  registerAgent(input: { key: string; agent_profile_id: string }): Promise<AgentRegistry> {
    return this.#request("POST", "/api/v1/orchestrator/agents", input);
  }

  createAgent(input: {
    key: string;
    name: string;
    template_profile_id: string;
    model?: string | null;
  }): Promise<AgentRegistry> {
    return this.#request("POST", "/api/v1/orchestrator/agents/create", input);
  }

  updateAgentProfile(
    id: string,
    input: { name: string; command: string; args: string[]; model?: string | null },
  ): Promise<AgentRegistry> {
    return this.#request(
      "PUT",
      `/api/v1/orchestrator/agents/profiles/${encodeURIComponent(id)}`,
      input,
    );
  }

  disableAgent(key: string): Promise<AgentRegistry> {
    return this.#request(
      "DELETE",
      `/api/v1/orchestrator/agents/${encodeURIComponent(key)}`,
    );
  }

  testAgentProfile(
    id: string,
    input: { workspace: string; prompt: string; timeout_seconds: number },
  ): Promise<{ ok: true; response: string }> {
    return this.#request(
      "POST",
      `/api/v1/orchestrator/agents/profiles/${encodeURIComponent(id)}/test`,
      input,
    );
  }

  memory(): Promise<MemorySection> {
    return this.#get("/api/v1/dashboard/memory");
  }

  remember(input: {
    content: string;
    layer: "LONG_TERM" | "PREFERENCE";
    tags: string[];
    acknowledgedSensitive: boolean;
  }): Promise<unknown> {
    return this.#request("POST", "/api/v1/memory", input);
  }

  forget(memoryId: string): Promise<unknown> {
    return this.#request("DELETE", `/api/v1/memory/${encodeURIComponent(memoryId)}`);
  }

  notifications(): Promise<NotificationSection> {
    return this.#get("/api/v1/dashboard/notifications?limit=100");
  }

  markNotificationRead(notificationId: string): Promise<unknown> {
    return this.#request(
      "POST",
      `/api/v1/notifications/${encodeURIComponent(notificationId)}/read`,
    );
  }

  createPaperAccount(input: { name: string; bankroll_eur: string }): Promise<unknown> {
    return this.#request("POST", "/api/v1/mission-control/paper/accounts", input);
  }

  createPaperMarket(input: { question: string; close_at: string }): Promise<unknown> {
    return this.#request("POST", "/api/v1/mission-control/paper/markets", input);
  }

  security(): Promise<SecuritySection> {
    return this.#get("/api/v1/dashboard/security?limit=200");
  }

  logs(filter: { level?: string; search?: string } = {}): Promise<LogSection> {
    const params = new URLSearchParams({ limit: "200" });
    if (filter.level !== undefined) params.set("level", filter.level);
    if (filter.search !== undefined && filter.search.length > 0)
      params.set("search", filter.search);

    return this.#get(`/api/v1/dashboard/logs?${params.toString()}`);
  }

  async #get<T>(path: string): Promise<T> {
    return this.#request("GET", path);
  }

  async #request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.#session.authorizedRequest({ method, path, body });

    if (response.status === 403 || response.status === 404) {
      // Le serveur ne distingue pas « pas administrateur » de « n'existe pas » —
      // délibérément, pour ne pas annoncer la surface d'administration. Le
      // client hérite de cette prudence et n'invente pas la distinction.
      throw new ForbiddenError("Cette section n'est pas accessible avec ce compte.");
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(messageOf(response.body));
    }

    return (response.body as { data: T }).data;
  }
}

function messageOf(body: unknown): string {
  if (body !== null && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (error !== null && typeof error === "object" && "message" in error) {
      return String(error.message);
    }
  }
  return "La requête a échoué.";
}

/**
 * Assemble une session pour le tableau de bord.
 *
 * Le coffre est **volatil** : les jetons vivent en mémoire et disparaissent au
 * rechargement. Un tableau de bord d'administration est précisément l'endroit où
 * l'on ne veut pas d'un jeton de longue durée lisible par n'importe quel script
 * de la page. Se reconnecter coûte dix secondes.
 */
export function createSession(baseUrl: string): SessionManager {
  const http: HttpClient = new FetchHttpClient(baseUrl);
  return new SessionManager({ http, storage: new VolatileStorage() });
}

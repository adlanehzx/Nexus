/**
 * Response shapes of the NEXUS API routes the mobile client reads.
 *
 * They mirror the Zod schemas in `services/api/src/routes/v1`. Fields the
 * screens never read are omitted on purpose: a smaller surface means a smaller
 * chance of breaking when the server adds to a response.
 */

export interface ConversationSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunResult {
  runId: string;
  conversationId: string;
  status: string;
  stopReason: string | null;
  response: string | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  confirmation: {
    id: string;
    toolName: string;
    riskLevel: string;
    expiresAt: string;
  } | null;
}

export interface AgentRunRow {
  runId: string;
  conversationId: string;
  missionExternalKey: string | null;
  replayOfRunId: string | null;
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
    errorCode: string | null;
  }[];
  errors: { at: string; code: string; message: string }[];
  metrics: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    toolCalls: number;
    failedToolCalls: number;
    fallbackCount: number;
  };
}

export interface AgentRegistry {
  worker_enabled: boolean;
  configured: {
    key: string;
    agent_profile_id: string;
    running_tasks: number;
    queued_tasks: number;
    last_task_state: string | null;
    status: string;
    cooldown_until: string | null;
    remaining_5h_percent: number | null;
    remaining_week_percent: number | null;
    resets_5h_at: string | null;
    resets_week_at: string | null;
    usage_source: string;
    consecutive_failures: number;
    last_error_category: string | null;
  }[];
  available: { id: string; name: string; agent_kind: string; model: string | null }[];
}

export interface Overview {
  at: string;
  devices: { total: number; online: number; degraded: number; revoked: number };
  workers: { total: number; connected: number; accepting: number; busy: number };
  tasks: { total: number; running: number; succeeded: number; failed: number; cancelled: number };
  agentRuns: { total: number; running: number; failed: number; waitingForConfirmation: number };
  notifications: { unread: number };
  health: { name: string; level: "ok" | "degraded" | "down" | "unconfigured"; detail: string }[];
  recentActivity: {
    at: string;
    kind: string;
    summary: string;
    level: "info" | "warning" | "error";
  }[];
}

export interface MissionTask {
  id: string;
  task_key: string;
  profile_key: string;
  state: string;
  result_json: string | null;
  error_json: string | null;
  depends_on: string[];
  attempts: { id: string; attempt_no: number; state: string; error_json: string | null }[];
}

export interface Mission {
  id: string;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  tasks: MissionTask[];
}

export interface MissionSchedule {
  id: string;
  name: string;
  state: "active" | "paused" | "completed";
  schedule_kind: "one_shot" | "cron";
  cron_expression: string | null;
  timezone: string;
  next_run_at: string | null;
  last_scheduled_at: string | null;
}

export interface MissionControlSection {
  configured: boolean;
  reachable: boolean;
  detail: string;
  missions: Mission[];
  schedules: MissionSchedule[];
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

export interface TaskStepRow {
  id: string;
  description: string;
  status: string;
  selectedDeviceName: string | null;
  riskLevel: string;
  error: { code: string; message: string } | null;
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progressPercent: number;
  steps: TaskStepRow[];
  source: "device" | "acp";
}

export interface UsageRun {
  runId: string;
  model: string;
  startedAt: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** `GET /usage`. `billedCostUsd` stays null until a provider billing source exists. */
export interface UsageReport {
  source: string;
  days: number;
  nextOffset?: number | null;
  runs: UsageRun[];
  billedCostUsd: number | null;
  providerQuota: unknown;
}

export interface ProviderAccount {
  id: string;
  provider: string;
  name: string;
  enabled?: boolean;
  authStatus: "authenticated" | "unauthenticated" | "expired" | "unknown";
  lastCheckedAt: string | null;
  quotas: {
    remaining5hPercent: number | null;
    remainingWeekPercent: number | null;
    resets5hAt: string | null;
    resetsWeekAt: string | null;
    exhausted: boolean;
  };
  cooldown: { active: boolean; until: string | null; reason: string | null };
  reliability: { score: number; totalRuns: number; failureCount: number };
}

export type LlmEngineConfig = {
  id: string;
  label: string;
  kind: "paid-api" | "device";
  enabled: boolean;
  priority: number;
  model: string;
  maxContextTokens: number;
  /** Prices declared by the administrator. Null means no estimate is possible. */
  inputCostPerMillion?: number | null;
  outputCostPerMillion?: number | null;
} & Record<string, unknown>;

export interface LlmEnginesSection {
  enabled: boolean;
  preferLocal: boolean;
  engines: LlmEngineConfig[];
  status: {
    engines: {
      id: string;
      label: string;
      kind: string;
      provider: string;
      model: string;
      enabled: boolean;
      priority: number;
      credentialConfigured: boolean;
    }[];
  } | null;
}

export interface McpServerStatus {
  name: string;
  status: string;
  toolCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  reconnectAttempts: number;
  circuitOpenUntil: string | null;
  serverInfo: { name: string; version: string } | null;
}

export type McpConfiguration = {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  defaultPermissions: string[];
  defaultRisk: string;
  toolPolicies: Record<string, unknown>;
  url?: string;
  command?: string;
} & Record<string, unknown>;

export interface McpSection {
  configured: boolean;
  configurations: McpConfiguration[];
  servers: McpServerStatus[];
}

export interface ToolRow {
  name: string;
  description: string;
  riskLevel: string;
  requiredPermissions: string[];
  allowed: boolean;
  source: string;
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
  agentVersion: string | null;
}

export interface SatelliteView {
  deviceId: string;
  name: string;
  health: Record<string, unknown>;
  capabilities: Record<string, unknown>[];
  lastSeenAt: string;
  online: boolean;
}

export interface SatelliteCommandAccepted {
  correlationId: string;
  command: string;
}

export interface PauseState {
  paused: boolean;
  reason: string | null;
  since: string | null;
}

export interface VisualControlStatus {
  active: boolean;
  paused: boolean;
  activeSessionId?: string;
  safetyBoundaryEnforced: boolean;
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  role?: string;
}

export interface ConnectionEntry {
  providerId: string;
  displayName: string;
  kind: string;
  supportedOnThisHost: boolean;
  observation: {
    state: string;
    version: string | null;
    authStatus: string;
    userMessage: string | null;
    requiresHumanAction: boolean;
    lastCheckedAt: string | null;
    authGuide?: { instructions: string; command: string | null } | null;
  } | null;
}

export interface ProviderDriver {
  id: string;
  displayName: string;
  capabilities: Record<string, boolean>;
}

export interface ProviderModel {
  id: string;
  provider: string;
  displayName: string;
  contextWindow?: number;
}

/** `POST /devices/:id/push-token`. Not shipped by the core yet: see docs/BACKEND-GAPS.md. */
export interface PushRegistration {
  token: string;
  provider: "expo";
}

import type { CareerProfileInput } from "@nexus/career";
import type {
  CareerProfileDto,
  CareerDocumentDto,
  CareerDocumentSummaryDto,
  CareerOpportunityDto,
  CareerApplicationDto,
} from "./career-api-client.js";

export interface PaperOrder {
  id: string;
  market_id: string;
  outcome: "yes" | "no";
  state: "filled" | "settled" | "voided";
  stake_cents: number;
  shares_micro: number;
  payout_cents: number | null;
  execution_price_ppm: number;
}
export interface PaperAccountDetail {
  id: string;
  name: string;
  cash_balance_cents: number;
  realized_pnl_cents: number;
  open_exposure_cents: number;
  orders: PaperOrder[];
}
export interface PaperMarketDetail {
  id: string;
  question: string;
  state: "open" | "settled" | "cancelled";
  close_at: string;
  winning_outcome: "yes" | "no" | null;
  latest_quote: { yes_price_ppm: number; liquidity_cents: number; observed_at: string } | null;
}
export interface PaperOrderInput {
  account_id: string;
  market_id: string;
  model_probability: string;
  confidence: string;
}
export type PaperOrderResult =
  | { filled: false; reasons: string[]; stake_cents: number }
  | { id: string; outcome: "yes" | "no"; stake_cents: number; filled?: true };
import { FetchHttpClient, SessionManager, VolatileStorage } from "@nexus/client-core";
import type { HttpClient, SecureStorage } from "@nexus/client-core";
import type {
  ArchivedEvidence,
  OsintAlert,
  OsintCaseRecord,
  OsintEntity,
  OsintInvestigation,
  OsintRelation,
  OsintWatch,
} from "@nexus/osint";

/**
 * Dashboard API client.
 *
 * Reuses `SessionManager` from `@nexus/client-core` — same connection, same
 * transparent refresh, same keyring — avoiding separate token expiration logic.
 *
 * Mutations are centralized here. They flow through the administrator session,
 * core validations, and explicit user confirmations for irreversible actions.
 *
 * Types represent what the server actually sends. No transcripts or reasoning
 * blocks appear here; the boundary is enforced on the server.
 */

export interface SystemPauseState {
  paused: boolean;
  reason: string | null;
  since: string | null;
}

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

export interface ConnectionObservation {
  id: string;
  providerId: string;
  kind: "acp" | "mcp" | "network" | "device";
  displayName: string;
  state:
    | "not_installed"
    | "detected"
    | "authentication_required"
    | "authenticating"
    | "testing"
    | "connected"
    | "degraded"
    | "expired"
    | "disconnected"
    | "error";
  version: string | null;
  executablePath: string | null;
  capabilities: string[];
  availableActions: string[];
  platform: "linux" | "darwin" | "win32" | "android" | "unknown";
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  authStatus: "authenticated" | "unauthenticated" | "expired" | "unknown";
  errorCategory: string | null;
  userMessage: string | null;
  requiresHumanAction: boolean;
  adapter: {
    availability: "available" | "missing" | "unknown";
    provenance: "official" | "community" | "unknown";
    provenanceEvidence: string;
  } | null;
  authGuide?: {
    kind: "cli_command" | "browser_url" | "manual";
    command: string | null;
    instructions: string;
    url: string | null;
  } | null;
}

export interface ConnectionCatalogEntry {
  providerId: string;
  displayName: string;
  kind: "acp" | "mcp" | "network" | "device";
  platforms: ("linux" | "darwin" | "win32" | "android" | "unknown")[];
  supportedOnThisHost: boolean;
  actions: ("detect" | "test" | "sign_in" | "sign_out" | "install" | "open_docs")[];
  docsUrl: string | null;
  adapter: {
    provenance: "official" | "community" | "unknown";
    provenanceEvidence: string;
  };
  observation: ConnectionObservation | null;
}

export interface ConnectionCatalog {
  connections: ConnectionCatalogEntry[];
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

export interface NetworkPeerDto {
  id: string;
  name: string;
  dnsName?: string;
  os: string;
  online: boolean;
  active: boolean;
  ipv4?: string;
}

export interface DeviceNetworkDiscoveryDto {
  installed: boolean;
  running: boolean;
  inventoryAvailable: boolean;
  backendState: string;
  tailnet?: string;
  suggestedApiUrl?: string;
  automaticPairingUrl: boolean;
  self?: NetworkPeerDto;
  peers: NetworkPeerDto[];
  guidance: string;
}

export interface WorkerRow extends DeviceRow {
  connected: boolean;
  acceptingTasks: boolean;
}

export interface PairingTicket {
  id: string;
  token: string;
  payload: string;
  expiresAt: string;
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
  source: "device" | "acp";
}

export interface TaskExecution {
  id: string;
  stepId: string;
  deviceId: string;
  attempt: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  input: unknown;
  result: unknown;
  error: { code: string; message: string } | null;
}

export interface TaskExecutionPage {
  data: TaskExecution[];
  meta: { nextCursor: string | null; total: number };
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
 * An agent run as reported by the server.
 *
 * Note what is omitted: no `messages`, no `providerBlocks`, no
 * transcript. Only status, action, tool, progress, result, error, and metrics.
 */
export interface AgentRunRow {
  runId: string;
  userId: string;
  conversationId: string;
  correlationId: string;
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
    fallbackCount: number;
  };
}

export interface ObservabilitySummary {
  generatedAt: string;
  totals: {
    runs: number;
    failedRuns: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    failedToolCalls: number;
    estimatedApiEquivalentCostUsd: number | null;
  };
  rates: { fallback: number; toolError: number; runError: number };
  agents: {
    agent: string;
    runs: number;
    failures: number;
    averageLatencyMs: number;
    p95LatencyMs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedApiEquivalentCostUsd: number | null;
  }[];
  missions: {
    mission: string;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedApiEquivalentCostUsd: number | null;
  }[];
}

export interface ToolRow {
  name: string;
  description: string;
  version: string;
  riskLevel: string;
  requiredPermissions: string[];
  allowed: boolean;
  source: "native" | "browser" | "search" | "acp";
}

export interface McpSection {
  configured: boolean;
  configurations: McpConfiguration[];
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

export type McpConfiguration = {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  defaultPermissions: string[];
  defaultRisk: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  toolPolicies: Record<string, unknown>;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
  exposeResources: boolean;
  sandbox?: {
    enabled: boolean;
    engine: "bwrap" | "docker" | "none";
    allowNetwork?: boolean;
    readOnlyRoot?: boolean;
  };
} & (
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      envRefs: Record<string, string>;
      cwd?: string;
    }
  | {
      transport: "http" | "sse";
      url: string;
      headers: Record<string, string>;
      headerRefs: Record<string, string>;
    }
);

export interface McpOAuthProviderDto {
  id: string;
  name: string;
  description: string;
  icon: string;
  docUrl: string;
  defaultScopes: string[];
  supportsPkce: boolean;
  connected: boolean;
  activeInRuntime: boolean;
  clientIdConfigured: boolean;
  vaultRef: string;
}

export interface BrowserSection {
  configured: boolean;
  reachable: boolean;
  detail: string;
  health: unknown;
  configuration:
    | { enabled: boolean; mode: "local-harness"; cdpUrl: string }
    | { enabled: boolean; mode: "remote-worker"; baseUrl: string; tokenRef: string }
    | null;
  tokenConfigured: boolean;
}

export interface MissionControlSection {
  configured: boolean;
  reachable: boolean;
  detail: string;
  health: null | {
    status: "ready";
    worker_enabled: boolean;
    worker_concurrency: number;
    scheduler_enabled: boolean;
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
  missions: {
    id: string;
    title: string;
    state: string;
    created_at: string;
    updated_at: string;
    tasks: {
      id: string;
      task_key: string;
      profile_key: string;
      state: string;
      result_json: string | null;
      error_json: string | null;
      created_at: string;
      updated_at: string;
      depends_on: string[];
      attempts: {
        id: string;
        attempt_no: number;
        state: string;
        conversation_id: string;
        started_at: string;
        updated_at: string;
        finished_at: string | null;
        error_json: string | null;
      }[];
    }[];
  }[];
  schedules: MissionSchedule[];
}

export interface MissionSchedule {
  id: string;
  name: string;
  state: "active" | "paused" | "completed";
  schedule_kind: "one_shot" | "cron";
  run_at: string | null;
  cron_expression: string | null;
  timezone: string;
  catch_up_policy: "skip" | "latest" | "all";
  max_catch_up: number;
  max_concurrency: number;
  misfire_grace_seconds: number;
  mission: {
    external_key: string;
    title: string;
    workspace: string;
    tasks: { key: string; profile: string; instruction: string }[];
  };
  next_run_at: string | null;
  last_scheduled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRun {
  id: string;
  schedule_id: string;
  scheduled_for: string;
  state: "pending" | "claimed" | "submitted" | "succeeded" | "failed" | "cancelled" | "skipped";
  mission_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
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
    system_prompt: string;
    reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null;
    additional_dirs: string[];
    config_options: Record<string, string>;
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

export interface ExternalNotificationConfigDto {
  enabled: boolean;
  desktop: { enabled: boolean; urgency: "low" | "normal" | "critical" };
  ntfy: { enabled: boolean; serverUrl: string; topic: string; tokenRef?: string };
  webhook?: {
    enabled: boolean;
    url?: string;
    format: "discord" | "telegram" | "apprise" | "generic";
    tokenRef?: string;
  };
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
    timezone: string;
    allowUrgent: boolean;
  };
  grouping: { enabled: boolean; windowSeconds: number };
  dashboardBaseUrl: string;
}

export interface NotificationTestReportDto {
  report: {
    messageId: string;
    timestamp: string;
    channels: {
      channel: string;
      success: boolean;
      error?: string;
      skippedReason?: string;
    }[];
  };
}

export interface ProviderAccountDto {
  id: string;
  provider: string;
  name: string;
  profileKey: string;
  enabled?: boolean;
  sessionDir: string;
  env: Record<string, string>;
  authStatus: "authenticated" | "unauthenticated" | "expired" | "unknown";
  lastCheckedAt: string | null;
  quotas: {
    remaining5hPercent: number | null;
    remainingWeekPercent: number | null;
    resets5hAt: string | null;
    resetsWeekAt: string | null;
    exhausted: boolean;
  };
  cooldown: {
    active: boolean;
    until: string | null;
    reason: string | null;
  };
  priority: number;
  reliability: {
    score: number;
    totalRuns: number;
    successCount: number;
    failureCount: number;
    consecutiveFailures: number;
    lastErrorCategory: string | null;
    lastErrorAt: string | null;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRoutingEntry {
  key: string;
  categoryScores: Record<string, number>;
  totalRuns: number;
  overallSuccessRate: number;
  avgDurationMs: number;
  healthStatus: string;
  authStatus: string;
  cooldownActive: boolean;
}

export interface TaskClassificationDto {
  primaryCategory: string;
  categoryWeights: Record<string, number>;
  requiresBrowser: boolean;
  estimatedComplexity: string;
  contextChars: number;
}

export interface RankedAgentDto {
  key: string;
  totalScore: number;
  isAvailable: boolean;
  unavailabilityReason?: string;
  recommendedCategory: string;
  breakdown: {
    compatibility: number;
    authentication: number;
    quota: number;
    health: number;
    quality: number;
    performance: number;
    context: number;
  };
}

export interface RoutingEvaluationDto {
  classification: TaskClassificationDto;
  ranked: RankedAgentDto[];
}

export interface SharedArtifactDto {
  id: string;
  missionKey: string;
  taskKey: string;
  name: string;
  relativePath: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  description: string;
  createdAt: string;
}

export interface CrossCritiqueDebateDto {
  id: string;
  taskA: { key: string; profile: string; summary: string; confidence: number };
  taskB: { key: string; profile: string; summary: string; confidence: number };
  issue: string;
  severity: string;
  recommendation: string;
}

export interface ProposedSubtaskDto {
  key: string;
  title: string;
  instruction: string;
  reason: string;
  priority: string;
  profile?: string;
  depends_on?: string[];
}

export interface MissionCollaborationDto {
  missionId: string;
  workspace: string;
  tasks: {
    taskKey: string;
    profileKey: string;
    state: string;
    structuredOutput: {
      summary: string;
      payloadType: string;
      confidenceScore: number;
      assumptions: string[];
      openQuestions: string[];
      proposedSubtasks: ProposedSubtaskDto[];
      artifacts: unknown[];
    };
    artifacts: SharedArtifactDto[];
  }[];
  artifacts: SharedArtifactDto[];
  debates: CrossCritiqueDebateDto[];
  proposedSubtasks: ProposedSubtaskDto[];
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

export interface RunComparisonDto {
  runA: {
    id: string;
    agentKey: string;
    durationMs: number;
    tokenCount: number;
    costEstimateUsd: number;
    stepCount: number;
    status: string;
  };
  runB: {
    id: string;
    agentKey: string;
    durationMs: number;
    tokenCount: number;
    costEstimateUsd: number;
    stepCount: number;
    status: string;
  };
  diffSummary: {
    durationDeltaMs: number;
    tokenDelta: number;
    fasterRunId: string;
    cheaperRunId: string;
  };
}

export interface QuotaForecastDto {
  providerId: string;
  accountLabel: string;
  currentUsage: number;
  hardLimit: number | null;
  estimatedDepletionDate: string | null;
  confidence: "high" | "medium" | "low" | "unknown";
  unknownReason?: string;
}

export interface DagNodeDto {
  id: string;
  label: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  dependencies: string[];
  assignedDevice?: string;
  output?: unknown;
  error?: string;
}

export interface DagDebugDto {
  taskId: string;
  isPaused: boolean;
  nodes: DagNodeDto[];
}

export interface AgentGraphNode {
  id: string;
  name: string;
  role: string;
  messageCount: number;
}

export interface AgentGraphEdge {
  source: string;
  target: string;
  messageCount: number;
  avgLatencyMs: number;
}

export interface CommunicationGraphDto {
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
}

export interface MarketplacePluginDto {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  status: "uninstalled" | "installed" | "paused" | "revoked";
  declaredTools: string[];
  reputationScore?: number;
}

export interface VisualControlStatusDto {
  active: boolean;
  paused: boolean;
  activeSessionId?: string;
  lastScreenshotUrl?: string;
  bounds: { width: number; height: number };
  safetyBoundaryEnforced: boolean;
}

export interface LinkedInStatus {
  configured: boolean;
  connected: boolean;
  tools: string[];
}

export interface FreeLlmStatus {
  enabled: boolean;
  model: string;
  strategy: "smart" | "priority" | "round_robin" | "quota_aware" | "latency";
  allowKeyless: boolean;
  nvidiaConfigured: boolean;
  activeProviders: string[];
}

export type PaidLlmProvider =
  | "openai"
  | "anthropic"
  | "google-gemini"
  | "openrouter"
  | "mistral"
  | "deepseek"
  | "openai-compatible";

export type LlmEngineConfig =
  | {
      id: string;
      label: string;
      kind: "paid-api";
      enabled: boolean;
      priority: number;
      model: string;
      maxContextTokens: number;
      provider: PaidLlmProvider;
      apiKeyRef: string;
      baseUrl: string | null;
      inputCostPerMillion: number | null;
      outputCostPerMillion: number | null;
    }
  | {
      id: string;
      label: string;
      kind: "device";
      enabled: boolean;
      priority: number;
      model: string;
      maxContextTokens: number;
      runtime: "ollama" | "openai-compatible";
      preferredDeviceId: string | null;
      minimumGpuVramMb: number;
    };

export interface LlmEnginesSection {
  enabled: boolean;
  preferLocal: boolean;
  engines: LlmEngineConfig[];
  status: {
    enabled: boolean;
    preferLocal: boolean;
    engines: {
      id: string;
      label: string;
      kind: "paid-api" | "device";
      provider: string;
      model: string;
      enabled: boolean;
      priority: number;
      credentialConfigured: boolean;
    }[];
  } | null;
  localDevices: {
    id: string;
    name: string;
    status: string;
    authenticated: boolean;
    eligible: boolean;
    gpuResources: { model: string; freeVramMb: number; totalVramMb: number }[];
    model: string | null;
    runtime: string | null;
  }[];
}

export interface WorktreeDto {
  id: string;
  path: string;
  branch: string;
  baseBranch?: string;
  headSha?: string;
  status: "active" | "dirty" | "stale" | "pruned";
  strategy?: "inherit" | "branch" | "share" | "isolated";
  createdAt: string;
}

export interface WorktreeStatusDto {
  clean: boolean;
  branch: string;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  files: string[];
}

export interface CheckpointDto {
  id: string;
  threadId: string;
  turnCount: number;
  gitRef: string;
  snapshotSha: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ThreadTurnDiffDto {
  threadId: string;
  fromTurnCount: number;
  toTurnCount: number;
  diff: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface SourceControlLinkDto {
  id: string;
  provider: "local" | "github" | "gitlab" | "bitbucket" | "azure-devops" | "forgejo" | "gitcafe";
  repoUrl: string;
  branch: string;
  pullRequestNumber?: number;
  headSha?: string;
  checksState: "unknown" | "pending" | "success" | "failure" | "error" | "skipped";
  reviewState: "unknown" | "pending" | "approved" | "changes_requested" | "commented";
  watched: boolean;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UnifiedProviderDto {
  id: string;
  displayName: string;
  capabilities: {
    streaming: boolean;
    toolCall: boolean;
    imageInput: boolean;
    audioInput: boolean;
    contextHandoff: boolean;
    checkpointRollback: boolean;
  };
}

export interface UnifiedModelDto {
  id: string;
  provider: string;
  modelId?: string;
  displayName: string;
  contextWindow?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
}

export class ForbiddenError extends Error {
  readonly code = "DASHBOARD_FORBIDDEN";
}

export interface UsageBucketDto {
  day: string;
  model: string;
  runs: number;
  failedRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  estimatedApiCostUsd: number | null;
}

export interface UsageSummaryDto {
  source: "agent_run_records";
  days: number;
  buckets: UsageBucketDto[];
}

export interface UsageQuotaAccountDto {
  id: string;
  provider: string;
  name: string;
  authStatus: string;
  lastCheckedAt: string | null;
  remaining5hPercent: number | null;
  remainingWeekPercent: number | null;
  resets5hAt: string | null;
  resetsWeekAt: string | null;
  exhausted: boolean;
}

export interface OrganizationDto {
  id: string;
  slug: string;
  name: string;
  mode: "LOCAL" | "HOSTED";
  role: string;
}

export interface OrganizationMemberDto {
  userId: string;
  email: string;
  displayName: string;
  role: string;
}

export interface McpTokenDto {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface McpActivityDto {
  id: string;
  tokenId: string;
  tool: string;
  outcome: string;
  errorCode: string | null;
  durationMs: number;
  createdAt: string;
}

export class DashboardApi {
  readonly #session: SessionManager;

  constructor(session: SessionManager) {
    this.#session = session;
  }

  careerDocuments(applicationId: string): Promise<{ documents: CareerDocumentSummaryDto[] }> {
    return this.#get(`/api/v1/career/applications/${encodeURIComponent(applicationId)}/documents`);
  }

  careerDocument(id: string): Promise<CareerDocumentDto> {
    return this.#get(`/api/v1/career/documents/${encodeURIComponent(id)}`);
  }

  tailorCareerDocument(input: {
    opportunityId: string;
    applicationId?: string | undefined;
    type: string;
  }): Promise<CareerDocumentDto> {
    return this.#request("POST", "/api/v1/career/documents/tailor", input);
  }

  careerProfile(): Promise<CareerProfileDto> {
    return this.#get("/api/v1/career/profile");
  }

  saveCareerProfile(input: CareerProfileInput): Promise<CareerProfileDto> {
    return this.#request("PUT", "/api/v1/career/profile", input);
  }

  careerOpportunities(
    track?: "all" | "phd" | "cdi" | "freelance",
  ): Promise<{ opportunities: CareerOpportunityDto[] }> {
    const query = new URLSearchParams({ limit: "200" });
    if (track && track !== "all") query.set("kind", track === "cdi" ? "permanent_job" : track);
    return this.#get(`/api/v1/career/opportunities?${query}`);
  }

  careerOpportunity(id: string): Promise<CareerOpportunityDto> {
    return this.#get(`/api/v1/career/opportunities/${encodeURIComponent(id)}`);
  }

  shortlistCareerOpportunity(id: string): Promise<CareerApplicationDto> {
    return this.#request(
      "POST",
      `/api/v1/career/opportunities/${encodeURIComponent(id)}/shortlist`,
    );
  }

  compareCareerOpportunities(
    ids: string[],
  ): Promise<{ items: CareerOpportunityDto[]; comparisonAttributes: string[] }> {
    return this.#request("POST", "/api/v1/career/opportunities/compare", { ids });
  }

  careerApplications(): Promise<{ applications: CareerApplicationDto[] }> {
    return this.#get("/api/v1/career/applications");
  }

  createCareerApplication(opportunityId: string): Promise<CareerApplicationDto> {
    return this.#request("POST", "/api/v1/career/applications", { opportunityId });
  }

  updateCareerApplicationStage(
    id: string,
    stage: string,
    note?: string,
  ): Promise<CareerApplicationDto> {
    return this.#request("PUT", `/api/v1/career/applications/${encodeURIComponent(id)}/stage`, {
      stage,
      note,
    });
  }

  overview(): Promise<Overview> {
    return this.#get("/api/v1/dashboard/overview");
  }

  devices(): Promise<{ devices: DeviceRow[] }> {
    return this.#get("/api/v1/dashboard/devices");
  }

  networkDiscovery(): Promise<DeviceNetworkDiscoveryDto> {
    return this.#get("/api/v1/devices/network-discovery");
  }

  createPairingTicket(label: string): Promise<PairingTicket> {
    return this.#request("POST", "/api/v1/devices/pairing-tickets", {
      ...(label.trim().length === 0 ? {} : { label: label.trim() }),
    });
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

  taskExecutions(taskId: string, cursor?: string): Promise<TaskExecutionPage> {
    const query = new URLSearchParams({ limit: "25" });
    if (cursor !== undefined) query.set("cursor", cursor);
    return this.#request(
      "GET",
      `/api/v1/tasks/${encodeURIComponent(taskId)}/executions?${query.toString()}`,
      undefined,
      false,
    );
  }

  cancelTask(taskId: string): Promise<{ cancelled: boolean }> {
    return this.#request("POST", `/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      reason: "cancelled from NEXUS supervision",
    });
  }

  trustDevice(deviceId: string): Promise<unknown> {
    return this.#request("POST", `/api/v1/devices/${encodeURIComponent(deviceId)}/trust`);
  }

  revokeDevice(deviceId: string): Promise<unknown> {
    return this.#request("POST", `/api/v1/devices/${encodeURIComponent(deviceId)}/revoke`);
  }

  disconnectDevice(deviceId: string): Promise<{ closed: number }> {
    return this.#request("DELETE", `/api/v1/devices/${encodeURIComponent(deviceId)}/sessions`);
  }

  updateDeviceCapabilities(
    deviceId: string,
    capabilities: { name: string; enabled: boolean; description?: string }[],
  ): Promise<{ capabilities: string[] }> {
    return this.#request("PUT", `/api/v1/devices/${encodeURIComponent(deviceId)}/capabilities`, {
      capabilities,
    });
  }

  updateDevicePermissions(deviceId: string, grantedPermissions: string[]): Promise<unknown> {
    return this.#request("PATCH", `/api/v1/devices/${encodeURIComponent(deviceId)}/permissions`, {
      grantedPermissions,
    });
  }

  runs(): Promise<{ runs: AgentRunRow[] }> {
    return this.#get("/api/v1/dashboard/runs?limit=100");
  }

  observability(): Promise<ObservabilitySummary> {
    return this.#get("/api/v1/dashboard/observability");
  }

  replayRun(runId: string): Promise<AgentRunRow> {
    return this.#request("POST", `/api/v1/dashboard/runs/${encodeURIComponent(runId)}/replay`, {
      mode: "analysis_only",
    });
  }

  tools(): Promise<{ tools: ToolRow[] }> {
    return this.#get("/api/v1/dashboard/tools");
  }

  mcp(): Promise<McpSection> {
    return this.#get("/api/v1/dashboard/mcp");
  }

  saveMcp(config: McpConfiguration): Promise<unknown> {
    return this.#request(
      "PUT",
      `/api/v1/dashboard/mcp/servers/${encodeURIComponent(config.name)}`,
      config,
    );
  }

  removeMcp(name: string): Promise<unknown> {
    return this.#request("DELETE", `/api/v1/dashboard/mcp/servers/${encodeURIComponent(name)}`);
  }

  reconnectMcp(name: string): Promise<unknown> {
    return this.#request(
      "POST",
      `/api/v1/dashboard/mcp/servers/${encodeURIComponent(name)}/reconnect`,
    );
  }

  browser(): Promise<BrowserSection> {
    return this.#get("/api/v1/dashboard/browser");
  }

  configureBrowser(
    input:
      | { enabled: boolean; mode: "local-harness"; cdpUrl: string }
      | { enabled: boolean; mode: "remote-worker"; baseUrl: string; tokenRef: string },
  ): Promise<unknown> {
    return this.#request("PUT", "/api/v1/dashboard/browser/configuration", input);
  }

  testBrowser(): Promise<unknown> {
    return this.#request("POST", "/api/v1/dashboard/browser/test");
  }

  secrets(): Promise<{ names: string[] }> {
    return this.#get("/api/v1/dashboard/secrets");
  }

  saveSecret(name: string, secret: string): Promise<unknown> {
    return this.#request("PUT", `/api/v1/dashboard/secrets/${encodeURIComponent(name)}`, {
      secret,
    });
  }

  removeSecret(name: string): Promise<unknown> {
    return this.#request("DELETE", `/api/v1/dashboard/secrets/${encodeURIComponent(name)}`);
  }

  freeLlmStatus(): Promise<FreeLlmStatus> {
    return this.#get("/api/v1/dashboard/llm/free");
  }

  configureFreeLlm(input: {
    enabled: boolean;
    model: string;
    strategy: FreeLlmStatus["strategy"];
    allowKeyless: boolean;
    nvidiaKeyRef: string | null;
  }): Promise<FreeLlmStatus> {
    return this.#request("PUT", "/api/v1/dashboard/llm/free", input);
  }

  testFreeLlm(): Promise<{ provider: string; model: string; text: string }> {
    return this.#request("POST", "/api/v1/dashboard/llm/free/test");
  }

  llmEngines(): Promise<LlmEnginesSection> {
    return this.#get("/api/v1/dashboard/llm/engines");
  }

  configureLlmEngines(input: {
    enabled: boolean;
    preferLocal: boolean;
    engines: LlmEngineConfig[];
  }): Promise<unknown> {
    return this.#request("PUT", "/api/v1/dashboard/llm/engines", input);
  }

  testLlmEngine(engineId: string): Promise<{ provider: string; model: string; text: string }> {
    return this.#request(
      "POST",
      `/api/v1/dashboard/llm/engines/${encodeURIComponent(engineId)}/test`,
    );
  }

  linkedInStatus(): Promise<LinkedInStatus> {
    return this.#get("/api/v1/linkedin/status");
  }

  startLinkedInOAuth(input: {
    clientId: string;
    clientSecretRef: string;
    tokenRef: string;
    redirectUri: string;
  }): Promise<{ authorizationUrl: string }> {
    return this.#request("POST", "/api/v1/linkedin/oauth/start", input);
  }

  disconnectLinkedIn(): Promise<LinkedInStatus> {
    return this.#request("POST", "/api/v1/linkedin/disconnect");
  }

  missionControl(): Promise<MissionControlSection> {
    return this.#get("/api/v1/dashboard/mission-control");
  }

  createSchedule(input: {
    name: string;
    mission: {
      external_key: string;
      title: string;
      workspace: string;
      tasks: { key: string; profile: string; instruction: string; depends_on: string[] }[];
    };
    timezone: string;
    run_at?: string;
    cron_expression?: string;
    catch_up_policy: "skip" | "latest" | "all";
    max_catch_up: number;
    max_concurrency: number;
    misfire_grace_seconds: number;
  }): Promise<MissionSchedule> {
    return this.#request("POST", "/api/v1/mission-control/schedules", input);
  }

  pauseSchedule(id: string): Promise<MissionSchedule> {
    return this.#request(
      "POST",
      `/api/v1/mission-control/schedules/${encodeURIComponent(id)}/pause`,
    );
  }

  resumeSchedule(id: string): Promise<MissionSchedule> {
    return this.#request(
      "POST",
      `/api/v1/mission-control/schedules/${encodeURIComponent(id)}/resume`,
    );
  }

  scheduleRuns(id: string): Promise<{ runs: ScheduleRun[] }> {
    return this.#get(`/api/v1/mission-control/schedules/${encodeURIComponent(id)}/runs?limit=100`);
  }

  sendToNexus(
    message: string,
    options?: {
      profile?: string;
      model?: string;
      reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    },
  ): Promise<OrchestratedMission> {
    return this.#request("POST", "/api/v1/orchestrator/messages", {
      message,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      ...(options?.profile ? { profile: options.profile } : {}),
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    });
  }

  osintCases(): Promise<{ cases: OsintCaseRecord[] }> {
    return this.#get("/api/v1/osint/cases");
  }

  createOsintCase(input: OsintInvestigation): Promise<OsintCaseRecord> {
    return this.#request("POST", "/api/v1/osint/cases", input);
  }

  osintCase(caseId: string): Promise<OsintCaseRecord> {
    return this.#get(`/api/v1/osint/cases/${encodeURIComponent(caseId)}`);
  }

  importOsintEvidence(caseId: string, dataset: string): Promise<{ evidence: ArchivedEvidence[] }> {
    return this.#request("POST", `/api/v1/osint/cases/${encodeURIComponent(caseId)}/import`, {
      dataset,
    });
  }

  addOsintEntity(caseId: string, input: Omit<OsintEntity, "id">): Promise<OsintEntity> {
    return this.#request(
      "POST",
      `/api/v1/osint/cases/${encodeURIComponent(caseId)}/entities`,
      input,
    );
  }

  addOsintRelation(caseId: string, input: Omit<OsintRelation, "id">): Promise<OsintRelation> {
    return this.#request(
      "POST",
      `/api/v1/osint/cases/${encodeURIComponent(caseId)}/relations`,
      input,
    );
  }

  addOsintWatch(caseId: string, query: string, intervalMinutes: number): Promise<OsintWatch> {
    return this.#request("POST", `/api/v1/osint/cases/${encodeURIComponent(caseId)}/watches`, {
      query,
      intervalMinutes,
    });
  }

  acknowledgeOsintAlert(caseId: string, alertId: string): Promise<OsintAlert> {
    return this.#request(
      "POST",
      `/api/v1/osint/cases/${encodeURIComponent(caseId)}/alerts/${encodeURIComponent(alertId)}/acknowledge`,
    );
  }

  enrichOsintCase(
    caseId: string,
    input: {
      provider:
        "sherlock" | "dns" | "rdap" | "certificate" | "company_registry" | "virustotal" | "shodan";
      query: string;
      secretRef?: string;
    },
  ): Promise<ArchivedEvidence> {
    return this.#request("POST", `/api/v1/osint/cases/${encodeURIComponent(caseId)}/enrich`, input);
  }

  osintReport(
    caseId: string,
    format: "markdown" | "pdf",
  ): Promise<{ format: "markdown" | "pdf"; content: string }> {
    return this.#get(`/api/v1/osint/cases/${encodeURIComponent(caseId)}/report?format=${format}`);
  }

  nexusMission(missionId: string): Promise<OrchestratedMission> {
    return this.#get(`/api/v1/orchestrator/missions/${encodeURIComponent(missionId)}`);
  }

  agents(): Promise<AgentRegistry> {
    return this.#get("/api/v1/orchestrator/agents");
  }

  connections(): Promise<ConnectionCatalog> {
    return this.#get("/api/v1/connections");
  }

  detectConnections(): Promise<ConnectionCatalog> {
    return this.#request("POST", "/api/v1/connections/detect");
  }

  testConnection(providerId: string): Promise<ConnectionCatalogEntry> {
    return this.#request("POST", `/api/v1/connections/${encodeURIComponent(providerId)}/test`);
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
    input: {
      name: string;
      command: string;
      args: string[];
      model?: string | null;
      system_prompt: string;
      reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null;
      additional_dirs: string[];
      config_options: Record<string, string>;
    },
  ): Promise<AgentRegistry> {
    return this.#request(
      "PUT",
      `/api/v1/orchestrator/agents/profiles/${encodeURIComponent(id)}`,
      input,
    );
  }

  disableAgent(key: string): Promise<AgentRegistry> {
    return this.#request("DELETE", `/api/v1/orchestrator/agents/${encodeURIComponent(key)}`);
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

  notificationConfig(): Promise<ExternalNotificationConfigDto> {
    return this.#get("/api/v1/dashboard/notifications/config");
  }

  saveNotificationConfig(config: ExternalNotificationConfigDto): Promise<{ saved: boolean }> {
    return this.#request("PUT", "/api/v1/dashboard/notifications/config", config);
  }

  testNotification(): Promise<NotificationTestReportDto> {
    return this.#request("POST", "/api/v1/dashboard/notifications/test");
  }

  providerAccounts(): Promise<{ accounts: ProviderAccountDto[] }> {
    return this.#get("/api/v1/orchestrator/accounts");
  }

  createProviderAccount(input: {
    id: string;
    provider: string;
    name: string;
    profileKey: string;
    priority?: number;
    sessionDir?: string;
  }): Promise<ProviderAccountDto> {
    return this.#request("POST", "/api/v1/orchestrator/accounts", input);
  }

  testProviderAccount(id: string): Promise<ProviderAccountDto> {
    return this.#request("POST", `/api/v1/orchestrator/accounts/${encodeURIComponent(id)}/test`);
  }

  toggleProviderAccountCooldown(
    id: string,
    active: boolean,
    durationSeconds?: number,
    reason?: string,
  ): Promise<ProviderAccountDto> {
    return this.#request(
      "POST",
      `/api/v1/orchestrator/accounts/${encodeURIComponent(id)}/cooldown`,
      { active, durationSeconds, reason },
    );
  }

  enableProviderAccount(id: string): Promise<ProviderAccountDto> {
    return this.#request("POST", `/api/v1/orchestrator/accounts/${encodeURIComponent(id)}/enable`);
  }

  disableProviderAccount(id: string): Promise<ProviderAccountDto> {
    return this.#request("POST", `/api/v1/orchestrator/accounts/${encodeURIComponent(id)}/disable`);
  }

  deleteProviderAccount(id: string): Promise<{ deleted: boolean }> {
    return this.#request("DELETE", `/api/v1/orchestrator/accounts/${encodeURIComponent(id)}`);
  }

  updateProviderAccount(
    id: string,
    input: {
      name?: string;
      profileKey?: string;
      priority?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ProviderAccountDto> {
    return this.#request("PATCH", `/api/v1/orchestrator/accounts/${encodeURIComponent(id)}`, input);
  }

  routingMatrix(): Promise<{ matrix: AgentRoutingEntry[] }> {
    return this.#get("/api/v1/orchestrator/routing/matrix");
  }

  evaluateRouting(instruction: string, contextChars?: number): Promise<RoutingEvaluationDto> {
    return this.#request("POST", "/api/v1/orchestrator/routing/evaluate", {
      instruction,
      contextChars,
    });
  }

  resetRoutingStats(): Promise<{ ok: boolean }> {
    return this.#request("POST", "/api/v1/orchestrator/routing/reset");
  }

  missionArtifacts(missionId: string): Promise<{ artifacts: SharedArtifactDto[] }> {
    return this.#get(`/api/v1/orchestrator/missions/${encodeURIComponent(missionId)}/artifacts`);
  }

  missionCollaboration(missionId: string): Promise<MissionCollaborationDto> {
    return this.#get(
      `/api/v1/orchestrator/missions/${encodeURIComponent(missionId)}/collaboration`,
    );
  }

  uploadMissionArtifact(
    missionId: string,
    input: {
      taskKey: string;
      name: string;
      content: string;
      description?: string;
      mimeType?: string;
    },
  ): Promise<{ artifact: SharedArtifactDto }> {
    return this.#request(
      "POST",
      `/api/v1/orchestrator/missions/${encodeURIComponent(missionId)}/artifacts`,
      input,
    );
  }

  artifactDownloadUrl(missionId: string, uri: string): string {
    return `/api/v1/orchestrator/missions/${encodeURIComponent(missionId)}/artifacts/download?uri=${encodeURIComponent(uri)}`;
  }

  getPaperAccount(id: string): Promise<PaperAccountDetail> {
    return this.#request("GET", `/api/v1/mission-control/paper/accounts/${encodeURIComponent(id)}`);
  }
  getPaperMarket(id: string): Promise<PaperMarketDetail> {
    return this.#request("GET", `/api/v1/mission-control/paper/markets/${encodeURIComponent(id)}`);
  }
  addPaperQuote(
    id: string,
    input: { yes_price: string; liquidity_eur: string; source_url: string; observed_at: string },
  ): Promise<unknown> {
    return this.#request(
      "POST",
      `/api/v1/mission-control/paper/markets/${encodeURIComponent(id)}/quotes`,
      input,
    );
  }
  placePaperOrder(input: PaperOrderInput, idempotencyKey: string): Promise<PaperOrderResult> {
    return this.#request("POST", "/api/v1/mission-control/paper/orders", input, {
      "idempotency-key": idempotencyKey,
    });
  }
  settlePaperMarket(id: string, outcome: "yes" | "no"): Promise<unknown> {
    return this.#request(
      "POST",
      `/api/v1/mission-control/paper/markets/${encodeURIComponent(id)}/settle`,
      { winning_outcome: outcome },
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

  compareRuns(runIdA: string, runIdB: string): Promise<RunComparisonDto> {
    return this.#get(
      `/api/v1/dashboard/runs/compare?a=${encodeURIComponent(runIdA)}&b=${encodeURIComponent(runIdB)}`,
    );
  }

  usage(
    days = 30,
    offset = 0,
  ): Promise<{
    source: "agent_run_records";
    nextOffset: number | null;
    days: number;
    runs: {
      runId: string;
      model: string;
      startedAt: string;
      status: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
    }[];
    billedCostUsd: null;
    providerQuota: null;
  }> {
    return this.#get(`/api/v1/usage?days=${days}&offset=${offset}`);
  }

  organizations(): Promise<{ organizations: OrganizationDto[] }> {
    return this.#get("/api/v1/organizations");
  }

  createOrganization(input: { name: string; slug: string }): Promise<unknown> {
    return this.#request("POST", "/api/v1/organizations", input);
  }

  organizationMembers(id: string): Promise<{ members: OrganizationMemberDto[] }> {
    return this.#get(`/api/v1/organizations/${encodeURIComponent(id)}/members`);
  }

  addOrganizationMember(id: string, input: { email: string; role: string }): Promise<unknown> {
    return this.#request("POST", `/api/v1/organizations/${encodeURIComponent(id)}/members`, input);
  }

  mcpTokens(): Promise<{ tokens: McpTokenDto[]; availableScopes: string[] }> {
    return this.#get("/api/v1/mcp/tokens");
  }

  createMcpToken(input: {
    name: string;
    scopes: string[];
    expiresInDays: number;
  }): Promise<{ token: string; record: McpTokenDto }> {
    return this.#request("POST", "/api/v1/mcp/tokens", input);
  }

  revokeMcpToken(id: string): Promise<{ revoked: true }> {
    return this.#request("DELETE", `/api/v1/mcp/tokens/${encodeURIComponent(id)}`);
  }

  mcpActivity(): Promise<{ activity: McpActivityDto[] }> {
    return this.#get("/api/v1/mcp/activity");
  }

  mcpExposedTools(): Promise<{
    tools: { name: string; description: string; requiredScope: string }[];
  }> {
    return this.#get("/api/v1/mcp/tools");
  }

  mcpOAuthProviders(): Promise<{ providers: McpOAuthProviderDto[] }> {
    return this.#get("/api/v1/mcp/oauth/providers");
  }

  mcpOAuthAuthorize(input: {
    providerId: string;
    clientId?: string;
    redirectUri?: string;
    scopes?: string[];
  }): Promise<{ authorizationUrl: string; state: string; providerId: string }> {
    return this.#request("POST", "/api/v1/mcp/oauth/authorize", input);
  }

  mcpOAuthCallback(input: {
    providerId: string;
    code: string;
    state: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  }): Promise<{ success: boolean; providerId: string; connected: boolean }> {
    return this.#request("POST", "/api/v1/mcp/oauth/callback", input);
  }

  mcpOAuthDisconnect(providerId: string): Promise<{ success: boolean; providerId: string }> {
    return this.#request("DELETE", `/api/v1/mcp/oauth/${encodeURIComponent(providerId)}`);
  }

  usageSummary(days = 30): Promise<UsageSummaryDto> {
    return this.#get(`/api/v1/usage/summary?days=${days}`);
  }

  usageQuotas(): Promise<{ accounts: UsageQuotaAccountDto[] }> {
    return this.#get("/api/v1/usage/quotas");
  }

  quotaForecast(): Promise<{ forecasts: QuotaForecastDto[] }> {
    return this.#get("/api/v1/dashboard/quota/forecast");
  }

  dagDebug(taskId: string): Promise<DagDebugDto> {
    return this.#get(`/api/v1/dashboard/dag/${encodeURIComponent(taskId)}`);
  }

  pauseDagStep(taskId: string, stepId: string): Promise<{ paused: boolean }> {
    return this.#request(
      "POST",
      `/api/v1/dashboard/dag/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}/pause`,
    );
  }

  resumeDagStep(taskId: string, stepId: string): Promise<{ resumed: boolean }> {
    return this.#request(
      "POST",
      `/api/v1/dashboard/dag/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}/resume`,
    );
  }

  communicationGraph(timeRange = "24h"): Promise<CommunicationGraphDto> {
    return this.#get(
      `/api/v1/dashboard/agents/communication-graph?range=${encodeURIComponent(timeRange)}`,
    );
  }

  marketplacePlugins(): Promise<{ plugins: MarketplacePluginDto[] }> {
    return this.#get("/api/v1/dashboard/marketplace/plugins");
  }

  installPlugin(id: string): Promise<{ success: boolean }> {
    return this.#request(
      "POST",
      `/api/v1/dashboard/marketplace/plugins/${encodeURIComponent(id)}/install`,
    );
  }

  togglePlugin(id: string, paused: boolean): Promise<{ paused: boolean }> {
    return this.#request(
      "POST",
      `/api/v1/dashboard/marketplace/plugins/${encodeURIComponent(id)}/toggle`,
      { paused },
    );
  }

  revokePlugin(id: string): Promise<{ revoked: boolean }> {
    return this.#request(
      "POST",
      `/api/v1/dashboard/marketplace/plugins/${encodeURIComponent(id)}/revoke`,
    );
  }

  visualControlStatus(): Promise<VisualControlStatusDto> {
    return this.#get("/api/v1/dashboard/visual-control/status");
  }

  toggleVisualControlPause(paused: boolean): Promise<{ paused: boolean }> {
    return this.#request("POST", "/api/v1/dashboard/visual-control/pause", { paused });
  }

  globalPause(): Promise<SystemPauseState> {
    return this.#get("/api/v1/pause");
  }

  setGlobalPause(paused: boolean, reason?: string): Promise<SystemPauseState> {
    return this.#request("POST", "/api/v1/pause", {
      paused,
      ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
    });
  }

  worktrees(workspaceRoot?: string): Promise<{ worktrees: WorktreeDto[] }> {
    const path = workspaceRoot
      ? `/api/v1/worktrees?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
      : "/api/v1/worktrees";
    return this.#get(path);
  }

  createWorktree(input: {
    workspaceRoot: string;
    branchName: string;
    baseBranch?: string;
    targetPath?: string;
    strategy?: "inherit" | "branch" | "share" | "isolated";
  }): Promise<{ worktree: WorktreeDto }> {
    return this.#request("POST", "/api/v1/worktrees", input);
  }

  worktreeStatus(worktreePath: string, workspaceRoot?: string): Promise<WorktreeStatusDto> {
    const query = new URLSearchParams({ worktreePath });
    if (workspaceRoot) query.set("workspaceRoot", workspaceRoot);
    return this.#get(`/api/v1/worktrees/status?${query.toString()}`);
  }

  handoffWorktree(input: {
    worktreePath: string;
    targetBranch: string;
    commitMessage: string;
    autoMerge?: boolean;
  }): Promise<{ success: boolean; commitSha?: string }> {
    return this.#request("POST", "/api/v1/worktrees/handoff", input);
  }

  removeWorktree(input: {
    workspaceRoot: string;
    worktreePath: string;
    force?: boolean;
    deleteBranch?: boolean;
  }): Promise<{ success: boolean }> {
    return this.#request("DELETE", "/api/v1/worktrees", input);
  }

  checkpoints(threadId: string): Promise<{ checkpoints: CheckpointDto[] }> {
    return this.#get(`/api/v1/checkpoints/${encodeURIComponent(threadId)}`);
  }

  createCheckpoint(
    threadId: string,
    input: { turnCount: number; cwd: string; description?: string },
  ): Promise<{ checkpoint: CheckpointDto }> {
    return this.#request("POST", `/api/v1/checkpoints/${encodeURIComponent(threadId)}`, input);
  }

  restoreCheckpoint(
    threadId: string,
    input: { turnCount: number; cwd: string },
  ): Promise<{ success: boolean; restoredTurnCount: number; gitRef: string }> {
    return this.#request(
      "POST",
      `/api/v1/checkpoints/${encodeURIComponent(threadId)}/restore`,
      input,
    );
  }

  checkpointDiff(
    threadId: string,
    fromTurn: number,
    toTurn: number,
    cwd?: string,
  ): Promise<{ diff: ThreadTurnDiffDto }> {
    const query = new URLSearchParams({
      fromTurn: String(fromTurn),
      toTurn: String(toTurn),
    });
    if (cwd) query.set("cwd", cwd);
    return this.#get(
      `/api/v1/checkpoints/${encodeURIComponent(threadId)}/diff?${query.toString()}`,
    );
  }

  sourceControlLinks(threadId?: string): Promise<{ links: SourceControlLinkDto[] }> {
    const path = threadId
      ? `/api/v1/source-control/links?threadId=${encodeURIComponent(threadId)}`
      : "/api/v1/source-control/links";
    return this.#get(path);
  }

  linkPullRequest(input: {
    provider: string;
    repoUrl: string;
    branch: string;
    pullRequestNumber?: number;
    headSha?: string;
    checksState?: string;
    reviewState?: string;
    watched?: boolean;
    threadId?: string;
  }): Promise<{ link: SourceControlLinkDto }> {
    return this.#request("POST", "/api/v1/source-control/links", input);
  }

  unlinkPullRequest(id: string): Promise<{ success: boolean }> {
    return this.#request("DELETE", `/api/v1/source-control/links/${encodeURIComponent(id)}`);
  }

  setPullRequestWatched(id: string, watched: boolean): Promise<{ link: SourceControlLinkDto }> {
    return this.#request("PATCH", `/api/v1/source-control/links/${encodeURIComponent(id)}/watch`, {
      watched,
    });
  }

  unifiedProviders(): Promise<{ providers: UnifiedProviderDto[] }> {
    return this.#get("/api/v1/providers");
  }

  unifiedProviderModels(providerId: string): Promise<{ models: UnifiedModelDto[] }> {
    return this.#get(`/api/v1/providers/${encodeURIComponent(providerId)}/models`);
  }

  validateProviderCredentials(
    providerId: string,
    credentials: Record<string, string>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.#request("POST", `/api/v1/providers/${encodeURIComponent(providerId)}/validate`, {
      credentials,
    });
  }

  createConversation(
    input: { title?: string | undefined } = {},
  ): Promise<{ id: string; title: string }> {
    const trimmedTitle = input.title?.trim();
    return this.#request<{ id: string; title: string }>("POST", "/api/v1/conversations", {
      title:
        trimmedTitle !== undefined && trimmedTitle.length > 0 ? trimmedTitle : "New Conversation",
    });
  }

  createAgentRun(input: {
    conversationId: string;
    prompt: string;
    model?: string | undefined;
    provider?: string | undefined;
  }): Promise<{ id: string; status: string; output?: string | undefined }> {
    return this.#request<{
      runId: string;
      conversationId: string;
      status: string;
      response: string | null;
      stopReason: string | null;
      usage?: { inputTokens: number; outputTokens: number };
    }>("POST", "/api/v1/agent-core/runs", {
      conversationId: input.conversationId,
      message: input.prompt,
      ...(input.model !== undefined && input.model.length > 0 ? { model: input.model } : {}),
    }).then((payload) => ({
      id: payload.runId,
      status: payload.status,
      output: payload.response ?? undefined,
    }));
  }

  getAgentRun(id: string): Promise<{ id: string; status: string; output?: string | undefined }> {
    return this.#get<{ runs: { runId: string; status: string; response?: string | null }[] }>(
      "/api/v1/agent-core/runs?limit=100",
    ).then((res) => {
      const match = res.runs.find((r) => r.runId === id);
      if (!match) {
        throw new Error(`Agent run ${id} not found`);
      }
      return {
        id: match.runId,
        status: match.status,
        output: match.response ?? undefined,
      };
    });
  }

  archiveConversation(conversationId: string): Promise<unknown> {
    return this.#request(
      "POST",
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/archive`,
    );
  }

  async #get<T>(path: string): Promise<T> {
    return this.#request("GET", path);
  }

  async #request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    headersOrUnwrap?: Record<string, string> | boolean,
    unwrapParam = true,
  ): Promise<T> {
    const headers =
      typeof headersOrUnwrap === "object" && headersOrUnwrap !== null ? headersOrUnwrap : undefined;
    const unwrap = typeof headersOrUnwrap === "boolean" ? headersOrUnwrap : unwrapParam;

    const response = await this.#session.authorizedRequest({
      method,
      path,
      body,
      ...(headers === undefined ? {} : { headers }),
    });

    if (response.status === 403) {
      throw new ForbiddenError("This section is not accessible with this account.");
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(messageOf(response.body));
    }

    const responseBody = response.body as { data?: T } | T;
    if (
      unwrap &&
      responseBody !== null &&
      typeof responseBody === "object" &&
      "data" in responseBody &&
      responseBody.data !== undefined
    ) {
      return (responseBody as { data: T }).data;
    }

    return responseBody as T;
  }
}

function messageOf(body: unknown): string {
  if (body !== null && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (error !== null && typeof error === "object" && "message" in error) {
      return String(error.message);
    }
  }
  return "Request failed.";
}

/**
 * Assembles a session for the dashboard.
 *
 * Tokens are scoped to the browser tab session: they survive refreshes but
 * are cleared when the tab closes. No tokens are written to permanent storage.
 */
export function createSession(
  baseUrl: string,
  onSignedOut?: (reason: string) => void,
): SessionManager {
  const http: HttpClient = new FetchHttpClient(baseUrl);
  return new SessionManager({
    storage: new TabSessionStorage(),
    http,
    ...(onSignedOut === undefined ? {} : { onSignedOut }),
  });
}

class TabSessionStorage implements SecureStorage {
  readonly #fallback = new VolatileStorage();

  async get(key: string): Promise<string | undefined> {
    try {
      return window.sessionStorage.getItem(key) ?? undefined;
    } catch {
      return this.#fallback.get(key);
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      await this.#fallback.set(key, value);
    }
  }

  async remove(key: string): Promise<void> {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage may be unavailable; fallback is cleared below.
    }
    await this.#fallback.remove(key);
  }
}

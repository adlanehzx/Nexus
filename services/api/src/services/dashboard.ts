import { canAcceptTasks, type Device } from "@nexus/devices";
import { projectAgentRun, type AgentRunView, type ProjectableRun } from "./observability.js";
import type { ServiceContainer } from "./container.js";
import type { MissionSnapshot, MissionTask } from "@nexus/mission-control-client";
import { missionOwnerPrefix } from "./acp-orchestrator.js";

/**
 * Le tableau de bord de supervision.
 *
 * Il **lit**, il n'agit pas. Aucune méthode de ce fichier ne modifie quoi que ce
 * soit : superviser et administrer sont deux surfaces, et les confondre ferait
 * d'un écran de consultation un moyen d'action à un clic de distance.
 *
 * Deux portées, et la distinction est délibérée :
 *
 *  - **ce qui appartient à quelqu'un** — appareils, tâches, souvenirs,
 *    notifications, runs — est lu pour le compte de l'administrateur, jamais
 *    pour tous les comptes. Le rôle `ADMIN` ouvre la supervision de
 *    l'infrastructure ; il n'a jamais eu vocation à donner accès aux
 *    conversations d'autrui, et faire l'inverse serait une décision beaucoup
 *    plus lourde que ce qui a été demandé ;
 *  - **ce qui n'appartient à personne** — serveurs MCP, worker navigateur,
 *    catalogue d'outils, journaux — est global.
 *
 * Troisième principe, qui gouverne les sections non câblées : **on ne peint pas
 * en vert ce qui n'existe pas.** Quand un sous-système n'est pas configuré, la
 * section le dit. Un voyant vert sur un composant absent est pire qu'un écran
 * vide : il fait chercher la panne ailleurs.
 */

export type HealthLevel = "ok" | "degraded" | "down" | "unconfigured";

export interface SubsystemHealth {
  name: string;
  level: HealthLevel;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface OverviewSnapshot {
  at: string;
  devices: { total: number; online: number; degraded: number; revoked: number };
  workers: { total: number; connected: number; accepting: number; busy: number };
  tasks: { total: number; running: number; succeeded: number; failed: number; cancelled: number };
  agentRuns: { total: number; running: number; failed: number; waitingForConfirmation: number };
  notifications: { unread: number };
  security: { eventsRetained: number; byKind: Record<string, number> };
  health: SubsystemHealth[];
  /** Les derniers événements de tout le système, fusionnés et datés. */
  recentActivity: ActivityEntry[];
}

export interface ActivityEntry {
  at: string;
  kind: "task" | "run" | "security" | "log";
  summary: string;
  level: "info" | "warning" | "error";
}

export interface DeviceView {
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

export interface WorkerView extends DeviceView {
  /** Le canal exécutant est-il réellement ouvert ? Vient de la passerelle. */
  connected: boolean;
  acceptingTasks: boolean;
}

export interface TaskStepView {
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

export interface TaskView {
  id: string;
  title: string;
  status: string;
  originClientDeviceId: string;
  correlationId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progressPercent: number;
  steps: TaskStepView[];
  source: "device" | "acp";
}

export interface TaskDetailView extends TaskView {
  /** Journal d'exécution : une entrée par tentative sur une machine. */
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

export interface ToolView {
  name: string;
  description: string;
  version: string;
  riskLevel: string;
  requiredPermissions: string[];
  /** Vrai si les permissions de l'administrateur couvrent cet outil. */
  allowed: boolean;
  source: "native" | "browser" | "acp";
}

export interface MemoryStats {
  total: number;
  byLayer: Record<string, number>;
  byOrigin: Record<string, number>;
  bySensitivity: Record<string, number>;
  recent: { id: string; content: string; layer: string; origin: string; createdAt: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardServiceOptions {
  services: ServiceContainer;
  now?: () => Date;
  /** Version affichée dans l'en-tête. Vient de la configuration. */
  apiVersion?: string;
}

export class DashboardService {
  readonly #services: ServiceContainer;
  readonly #now: () => Date;
  readonly #apiVersion: string;

  constructor(options: DashboardServiceOptions) {
    this.#services = options.services;
    this.#now = options.now ?? (() => new Date());
    this.#apiVersion = options.apiVersion ?? "0.0.0";
  }

  get apiVersion(): string {
    return this.#apiVersion;
  }

  // ── Vue d'ensemble ──────────────────────────────────────────────────────

  async overview(userId: string): Promise<OverviewSnapshot> {
    const [devices, plans, runs] = await Promise.all([
      this.#services.deviceRegistry.listDevices(userId),
      this.#services.taskStore.listByUser(userId, 200),
      this.listAgentRuns(userId, 200),
    ]);

    const workers = devices.filter((device) => canAcceptTasks(device.role));
    const connected = workers.filter((device) => this.#services.gateway.isConnected(device.id));

    const notifications = await this.#services.notificationStore.listByUser(
      userId,
      { limit: 200 },
      { unreadOnly: true },
    );

    return {
      at: this.#now().toISOString(),
      devices: {
        total: devices.length,
        online: devices.filter((device) => device.status === "ONLINE").length,
        degraded: devices.filter((device) => device.status === "DEGRADED").length,
        revoked: devices.filter((device) => device.trust === "REVOKED").length,
      },
      workers: {
        total: workers.length,
        connected: connected.length,
        accepting: connected.filter(
          (device) => device.health.activeTasks < device.health.maxConcurrentTasks,
        ).length,
        busy: connected.filter((device) => device.health.activeTasks > 0).length,
      },
      tasks: {
        total: plans.length,
        running: plans.filter((plan) => plan.status === "running").length,
        succeeded: plans.filter((plan) => plan.status === "succeeded").length,
        failed: plans.filter((plan) => plan.status === "failed").length,
        cancelled: plans.filter((plan) => plan.status === "cancelled").length,
      },
      agentRuns: {
        total: runs.length,
        running: runs.filter((run) => run.status === "running").length,
        failed: runs.filter((run) => run.status === "failed").length,
        waitingForConfirmation: runs.filter((run) => run.status === "waiting_for_confirmation")
          .length,
      },
      notifications: { unread: notifications.total },
      security: {
        eventsRetained: this.#services.securityLog.size,
        byKind: this.#services.securityLog.countByKind(),
      },
      health: this.health(devices),
      recentActivity: this.#recentActivity(plans, runs),
    };
  }

  /**
   * Santé des sous-systèmes.
   *
   * `unconfigured` est un niveau à part entière, distinct de `down`. Un serveur
   * MCP qu'on n'a jamais branché n'est pas en panne, et l'afficher en rouge
   * enverrait chercher un incident qui n'existe pas.
   */
  health(devices: readonly Device[]): SubsystemHealth[] {
    const workers = devices.filter((device) => canAcceptTasks(device.role));
    const connected = workers.filter((device) => this.#services.gateway.isConnected(device.id));

    const entries: SubsystemHealth[] = [
      {
        name: "API",
        level: "ok",
        detail: `version ${this.#apiVersion}`,
      },
      {
        name: "Exécutants",
        level:
          workers.length === 0
            ? "unconfigured"
            : connected.length === 0
              ? "down"
              : connected.length < workers.length
                ? "degraded"
                : "ok",
        detail:
          workers.length === 0
            ? "aucun exécutant appairé"
            : `${String(connected.length)}/${String(workers.length)} connecté(s)`,
      },
      {
        name: "Clients temps réel",
        level: this.#services.router.connectedDeviceIds.length === 0 ? "degraded" : "ok",
        detail: `${String(this.#services.router.connectedDeviceIds.length)} client(s) attaché(s)`,
      },
      this.#mcpHealth(),
      this.#browserHealth(),
      {
        name: "Mémoire",
        level: "ok",
        detail: "magasin en mémoire",
      },
    ];

    return entries;
  }

  #mcpHealth(): SubsystemHealth {
    const manager = this.#services.mcp;
    if (manager === undefined) {
      return { name: "MCP", level: "unconfigured", detail: "aucun serveur MCP configuré" };
    }

    const servers = manager.health();
    const connected = servers.filter((server) => server.status === "connected").length;

    return {
      name: "MCP",
      level:
        servers.length === 0 ? "unconfigured" : connected === servers.length ? "ok" : "degraded",
      detail: `${String(connected)}/${String(servers.length)} serveur(s) connecté(s)`,
    };
  }

  #browserHealth(): SubsystemHealth {
    if (this.#services.browser === undefined) {
      return {
        name: "Browser Use",
        level: "unconfigured",
        detail: "worker navigateur non configuré",
      };
    }
    // La sonde est asynchrone et le worker peut être lent : l'état réel est
    // rendu par la section dédiée, qui l'interroge. Ici on dit seulement qu'il
    // est câblé — mentir sur sa santé serait pire que ne rien dire.
    return { name: "Browser Use", level: "ok", detail: "configuré ; voir la section dédiée" };
  }

  #recentActivity(
    plans: readonly {
      title: string;
      status: string;
      createdAt: string;
      completedAt: string | null;
    }[],
    runs: readonly AgentRunView[],
  ): ActivityEntry[] {
    const entries: ActivityEntry[] = [];

    for (const plan of plans.slice(0, 20)) {
      entries.push({
        at: plan.completedAt ?? plan.createdAt,
        kind: "task",
        summary: `Tâche « ${plan.title} » — ${plan.status}`,
        level: plan.status === "failed" ? "error" : "info",
      });
    }

    for (const run of runs.slice(0, 20)) {
      entries.push({
        at: run.endedAt ?? run.startedAt,
        kind: "run",
        summary: `Run agent ${run.runId.slice(0, 8)} — ${run.status}`,
        level: run.status === "failed" ? "error" : "info",
      });
    }

    for (const event of this.#services.securityLog.list({ limit: 20 })) {
      entries.push({
        at: event.at,
        kind: "security",
        summary: event.summary,
        level: event.kind.endsWith("_failed") || event.kind.endsWith("denied") ? "warning" : "info",
      });
    }

    return entries.sort((left, right) => (left.at < right.at ? 1 : -1)).slice(0, 30);
  }

  // ── Appareils ───────────────────────────────────────────────────────────

  async listDevices(userId: string): Promise<DeviceView[]> {
    const devices = await this.#services.deviceRegistry.listDevices(userId);
    return devices.map((device) => presentDevice(device));
  }

  async getDevice(userId: string, deviceId: string): Promise<DeviceView | undefined> {
    const device = await this.#services.deviceRegistry.getDevice(deviceId);
    // Vérification de propriété, comme partout : un identifiant deviné ne doit
    // rien ouvrir, fût-ce depuis un compte administrateur.
    if (device?.userId !== userId) return undefined;
    return presentDevice(device);
  }

  // ── Exécutants ──────────────────────────────────────────────────────────

  async listWorkers(userId: string): Promise<WorkerView[]> {
    const devices = await this.#services.deviceRegistry.listDevices(userId);

    return devices
      .filter((device) => canAcceptTasks(device.role))
      .map((device) => {
        const connected = this.#services.gateway.isConnected(device.id);
        return {
          ...presentDevice(device),
          connected,
          acceptingTasks:
            connected &&
            device.status === "ONLINE" &&
            device.health.activeTasks < device.health.maxConcurrentTasks,
        };
      });
  }

  // ── Tâches ──────────────────────────────────────────────────────────────

  async listTasks(userId: string, limit = 50): Promise<TaskView[]> {
    const [plans, missions] = await Promise.all([
      this.#services.taskStore.listByUser(userId, limit),
      this.#acpMissions(userId, limit),
    ]);
    const names = await this.#deviceNames(userId);

    return [...plans.map((plan) => presentTask(plan, names)), ...missions.map(presentAcpTask)]
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async getTask(userId: string, taskId: string): Promise<TaskDetailView | undefined> {
    const plan = await this.#services.taskStore.get(taskId);
    if (plan === undefined) {
      const mission = await this.#services.missionControl?.getMission(taskId);
      if (!mission?.external_key.startsWith(`${missionOwnerPrefix(userId)}-`)) {
        return undefined;
      }
      return presentAcpTaskDetail(mission);
    }
    if (plan.userId !== userId) return undefined;

    const names = await this.#deviceNames(userId);
    const executions = await this.#services.taskStore.listExecutions(taskId);

    return {
      ...presentTask(plan, names),
      executions: executions.map((execution) => ({
        id: execution.id,
        stepId: execution.stepId,
        deviceId: execution.deviceId,
        deviceName: names.get(execution.deviceId) ?? null,
        status: execution.status,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        durationMs:
          execution.completedAt === null
            ? null
            : new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime(),
        // Le résultat est celui que le coordinateur a bien voulu conserver : un
        // résultat marqué sensible y a déjà été remplacé par un marqueur.
        result: execution.result,
        error:
          execution.error === null
            ? null
            : { code: execution.error.code, message: execution.error.message },
      })),
    };
  }

  async #deviceNames(userId: string): Promise<Map<string, string>> {
    const devices = await this.#services.deviceRegistry.listDevices(userId);
    return new Map(devices.map((device) => [device.id, device.name]));
  }

  // ── Runs d'agent ────────────────────────────────────────────────────────

  /**
   * Les runs de l'administrateur, **projetés**.
   *
   * `projectAgentRun` ne lit que `record` : le transcript et les blocs de
   * raisonnement du fournisseur ne traversent jamais cette frontière.
   */
  async listAgentRuns(userId: string, limit = 50): Promise<AgentRunView[]> {
    const [runs, missions] = await Promise.all([
      this.#services.runStore.listAll(),
      this.#acpMissions(userId, limit),
    ]);

    const native = runs
      .filter((run) => run.record.userId === userId)
      .map((run) => projectAgentRun(run as ProjectableRun));
    const acp = missions.flatMap((mission) =>
      mission.tasks.map((task) => presentAcpRun(userId, mission, task)),
    );
    return [...native, ...acp]
      .sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1))
      .slice(0, limit);
  }

  async getAgentRun(userId: string, runId: string): Promise<AgentRunView | undefined> {
    const run = await this.#services.runStore.load(runId);
    if (run?.record.userId !== userId) return undefined;
    return projectAgentRun(run);
  }

  // ── Outils ──────────────────────────────────────────────────────────────

  async listTools(userId: string): Promise<ToolView[]> {
    const granted = new Set(await this.#services.permissionsFor(userId));
    const native: ToolView[] = this.#services.toolRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      version: tool.version ?? "1",
      riskLevel: tool.riskLevel,
      requiredPermissions: [...tool.requiredPermissions],
      allowed: tool.requiredPermissions.every((permission) => granted.has(permission)),
      source: tool.name.startsWith("browser.") ? "browser" : "native",
    }));
    if (this.#services.missionControl === undefined) return native;
    try {
      const registry = await this.#services.missionControl.agents();
      return [
        ...native,
        ...registry.configured.map((agent) => ({
          name: `acp.${agent.key}`,
          description: `Délègue une tâche durable au profil ACP ${agent.key}.`,
          version: "1",
          riskLevel: "MEDIUM",
          requiredPermissions: [],
          allowed:
            registry.worker_enabled && (agent.status === "available" || agent.status === "unknown"),
          source: "acp" as const,
        })),
      ];
    } catch {
      return native;
    }
  }

  // ── Mémoire ─────────────────────────────────────────────────────────────

  async memoryStats(userId: string): Promise<MemoryStats> {
    const hits = await this.#services.memoryService.list({ userId, limit: 500 });

    const byLayer: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    const bySensitivity: Record<string, number> = {};

    for (const hit of hits) {
      byLayer[hit.record.layer] = (byLayer[hit.record.layer] ?? 0) + 1;
      byOrigin[hit.record.origin] = (byOrigin[hit.record.origin] ?? 0) + 1;
      bySensitivity[hit.record.sensitivity] = (bySensitivity[hit.record.sensitivity] ?? 0) + 1;
    }

    return {
      total: hits.length,
      byLayer,
      byOrigin,
      bySensitivity,
      recent: hits.slice(0, 20).map((hit) => ({
        id: hit.record.id,
        content: hit.record.content,
        layer: hit.record.layer,
        origin: hit.record.origin,
        createdAt: hit.record.validFrom.toISOString(),
      })),
    };
  }

  async #acpMissions(userId: string, limit: number): Promise<MissionSnapshot[]> {
    if (this.#services.missionControl === undefined) return [];
    try {
      return await this.#services.missionControl.listMissions(
        limit,
        `${missionOwnerPrefix(userId)}-`,
      );
    } catch {
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function presentDevice(device: Device): DeviceView {
  return {
    id: device.id,
    name: device.name,
    role: device.role,
    type: device.type,
    platform: device.platform,
    status: device.status,
    trust: device.trust,
    authenticated: device.authenticated,
    capabilities: device.capabilities.map((capability) => ({
      name: capability.name,
      enabled: capability.enabled,
      version: capability.version,
      description: capability.description,
    })),
    grantedPermissions: [...device.grantedPermissions],
    lastHeartbeatAt: device.lastSeenAt === null ? null : device.lastSeenAt.toISOString(),
    health: {
      activeTasks: device.health.activeTasks,
      maxConcurrentTasks: device.health.maxConcurrentTasks,
      cpuLoad: device.health.cpuLoad ?? null,
      memoryFreeMb: device.health.memoryFreeMb ?? null,
      diskFreeMb: device.health.diskFreeMb ?? null,
      batteryPercent: device.health.batteryPercent ?? null,
      onBattery: device.health.onBattery ?? null,
      latencyMs: device.health.latencyMs ?? null,
      reportedAt: device.health.reportedAt ?? null,
    },
    pairedAt: device.pairedAt.toISOString(),
    revokedAt: device.revokedAt === null ? null : device.revokedAt.toISOString(),
    agentVersion: device.agentVersion,
  };
}

interface PlanLike {
  id: string;
  title: string;
  status: string;
  originClientDeviceId: string;
  correlationId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  steps: readonly {
    id: string;
    description: string;
    tool: string;
    requiredCapabilities: readonly string[];
    status: string;
    selectedDeviceId: string | null;
    riskLevel: string;
    error: { code: string; message: string } | null;
  }[];
}

function presentTask(plan: PlanLike, names: Map<string, string>): TaskView {
  const done = plan.steps.filter(
    (step) => step.status === "succeeded" || step.status === "failed" || step.status === "skipped",
  ).length;

  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    originClientDeviceId: plan.originClientDeviceId,
    correlationId: plan.correlationId,
    createdAt: plan.createdAt,
    startedAt: plan.startedAt,
    completedAt: plan.completedAt,
    progressPercent: plan.steps.length === 0 ? 0 : Math.round((done / plan.steps.length) * 100),
    source: "device",
    steps: plan.steps.map((step) => ({
      id: step.id,
      description: step.description,
      tool: step.tool,
      requiredCapabilities: [...step.requiredCapabilities],
      status: step.status,
      selectedDeviceId: step.selectedDeviceId,
      selectedDeviceName:
        step.selectedDeviceId === null ? null : (names.get(step.selectedDeviceId) ?? null),
      riskLevel: step.riskLevel,
      error: step.error === null ? null : { code: step.error.code, message: step.error.message },
    })),
  };
}

function presentAcpTask(mission: MissionSnapshot): TaskView {
  const terminal = new Set(["succeeded", "failed", "cancelled", "skipped"]);
  const done = mission.tasks.filter((task) => terminal.has(task.state)).length;
  const attempts = mission.tasks.flatMap((task) => task.attempts);
  const startedAt = attempts.map((attempt) => attempt.started_at).sort()[0] ?? null;
  return {
    id: mission.id,
    title: mission.title,
    status: mission.state,
    originClientDeviceId: "ACP",
    correlationId: `mission:${mission.id}`,
    createdAt: mission.created_at,
    startedAt,
    completedAt: terminal.has(mission.state) ? mission.updated_at : null,
    progressPercent:
      mission.tasks.length === 0 ? 0 : Math.round((done / mission.tasks.length) * 100),
    source: "acp",
    steps: mission.tasks.map((task) => ({
      id: task.id,
      description: task.task_key,
      tool: `acp.${task.profile_key}`,
      requiredCapabilities: ["acp"],
      status: task.state,
      selectedDeviceId: task.profile_key,
      selectedDeviceName: task.profile_key,
      riskLevel: "MEDIUM",
      error: parseAcpError(task.error_json),
    })),
  };
}

function presentAcpTaskDetail(mission: MissionSnapshot): TaskDetailView {
  return {
    ...presentAcpTask(mission),
    executions: mission.tasks.flatMap((task) =>
      task.attempts.map((attempt) => ({
        id: attempt.id,
        stepId: task.id,
        deviceId: task.profile_key,
        deviceName: task.profile_key,
        status: attempt.state,
        startedAt: attempt.started_at,
        completedAt: attempt.finished_at,
        durationMs:
          attempt.finished_at === null
            ? null
            : new Date(attempt.finished_at).getTime() - new Date(attempt.started_at).getTime(),
        result: task.result_json === null ? null : safeJson(task.result_json),
        error: parseAcpError(attempt.error_json),
      })),
    ),
  };
}

function presentAcpRun(userId: string, mission: MissionSnapshot, task: MissionTask): AgentRunView {
  const firstAttempt = task.attempts[0];
  const lastAttempt = task.attempts.at(-1);
  const startedAt = firstAttempt?.started_at ?? task.created_at;
  const endedAt = lastAttempt?.finished_at ?? (isAcpTerminal(task.state) ? task.updated_at : null);
  const error = parseAcpError(task.error_json ?? lastAttempt?.error_json ?? null);
  return {
    runId: lastAttempt?.id ?? task.id,
    userId,
    conversationId: lastAttempt?.conversation_id ?? task.id,
    correlationId: `mission:${mission.id}:${task.task_key}`,
    status:
      task.state === "succeeded" ? "completed" : task.state === "failed" ? "failed" : task.state,
    stopReason: task.state === "succeeded" ? "completed" : (error?.code ?? null),
    startedAt,
    endedAt,
    durationMs:
      endedAt === null ? null : new Date(endedAt).getTime() - new Date(startedAt).getTime(),
    iterations: task.attempts.length,
    response: responseFromAcp(task.result_json),
    tools: [
      {
        callId: task.id,
        tool: `acp.${task.profile_key}`,
        riskLevel: "MEDIUM",
        status:
          task.state === "succeeded" ? "success" : task.state === "failed" ? "failed" : task.state,
        durationMs:
          endedAt === null ? 0 : new Date(endedAt).getTime() - new Date(startedAt).getTime(),
        attempts: task.attempts.length,
        action: `${task.task_key}${task.depends_on.length === 0 ? "" : ` ← ${task.depends_on.join(", ")}`}`,
        errorCode: error?.code ?? null,
      },
    ],
    errors:
      error === null
        ? []
        : [
            {
              at: task.updated_at,
              code: error.code,
              message: error.message,
              iteration: task.attempts.length,
            },
          ],
    metrics: {
      model: task.profile_key,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 1,
      failedToolCalls: error === null ? 0 : 1,
    },
  };
}

function isAcpTerminal(state: string): boolean {
  return (
    state === "succeeded" || state === "failed" || state === "cancelled" || state === "skipped"
  );
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseAcpError(raw: string | null): { code: string; message: string } | null {
  if (raw === null) return null;
  const parsed = safeJson(raw);
  if (parsed !== null && typeof parsed === "object") {
    const value = parsed as { code?: unknown; error?: unknown; message?: unknown };
    const message = value.message ?? value.error;
    return {
      code: typeof value.code === "string" ? value.code : "ACP_ERROR",
      message: typeof message === "string" ? message : "Échec de l'agent ACP",
    };
  }
  return { code: "ACP_ERROR", message: "Échec de l'agent ACP" };
}

function responseFromAcp(raw: string | null): string | null {
  if (raw === null) return null;
  const parsed = safeJson(raw);
  if (parsed !== null && typeof parsed === "object" && "response" in parsed) {
    const response = (parsed as { response?: unknown }).response;
    return typeof response === "string" ? response : null;
  }
  return null;
}

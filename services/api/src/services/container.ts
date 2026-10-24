import { resolve } from "node:path";
import { InMemoryAgentRunClaimStore, type AgentRunClaimStore } from "./agent-run-claims.js";
import {
  InMemoryMissionGrantRegistry,
  MissionGrantService,
  type MissionGrantRegistry,
} from "./mission-grants.js";
import {
  InMemoryScheduleGrantRegistry,
  ScheduleGrantService,
  type ScheduleGrantRegistry,
} from "./schedule-grants.js";
import { TokenService, type ScryptParams } from "@nexus/auth";
import type { LLMProvider } from "@nexus/llm";
import {
  DeviceRegistry,
  DeviceSelector,
  DeviceSessionService,
  EventRouter,
  InMemoryCredentialProvider,
  InMemoryPairingTicketStore,
  InMemoryTaskStore,
  PairingService,
  TaskCoordinator,
  WorkerGateway,
  ecdsaP256Verifier,
  ed25519Verifier,
  type DeviceCredentialStore,
  type DeviceStore,
  type PairingTicketStore,
  type SignatureVerifier,
  type TaskPlan,
  type TaskStore,
} from "@nexus/devices";
import {
  ConfirmationService,
  InMemoryConfirmationStore,
  PermissionService,
  ToolRegistry,
} from "@nexus/tools";
import {
  AgentOrchestrator,
  InMemoryAgentRunStore,
  type AgentRunStore,
  type AgentState,
} from "@nexus/agent-core";
import type { McpManager } from "@nexus/mcp";
import {
  createBrowserTools,
  createNativeBrowserTools,
  type BrowserWorkerClient,
  type BrowserSessionManager,
} from "@nexus/browser-client";
import type { MissionControlPort } from "@nexus/mission-control-client";
import type { PrismaClient } from "@nexus/database";
import {
  ContextAssembler,
  InMemoryMemoryProvider,
  MemoryService,
  PostgresMemoryProvider,
  ShortTermContext,
  type EmbeddingProvider,
  type MemoryProvider,
} from "@nexus/memory";
import { AuthService } from "./auth-service.js";
import {
  InMemoryConversationStore,
  InMemoryNotificationStore,
  InMemorySessionStore,
  InMemoryUserStore,
  type ConversationStore,
  type NotificationStore,
  type SessionStore,
  type UserStore,
} from "./stores.js";
import { NotificationService } from "./notification-service.js";
import { ConfirmationBroker } from "./confirmation-broker.js";
import type { NotificationDispatcher } from "@nexus/notifications";
import { TaskSupervisor } from "./task-supervisor.js";
import { LogBuffer, SecurityLog } from "./observability.js";
import { DashboardService } from "./dashboard.js";
import { PauseSwitch } from "./pause.js";
import type { KeyringVault, RuntimeConfigurationStore } from "./runtime-configuration.js";
import { ProviderAccountService } from "./provider-accounts.js";
import { AgentRouter } from "./agent-router.js";
import { SharedArtifactStore } from "./shared-artifacts.js";
import { AgentCollaborationService } from "./agent-collaboration.js";
import { NexusTelemetry, ObservableAgentRunStore } from "./domain-telemetry.js";
import { LocalConnectionManager, type ConnectionCatalogService } from "./connection-manager.js";
import { TenantPlatformService, TenantRealtimeHub } from "./tenant-platform.js";

/**
 * Assembly of API services.
 *
 * A single location connects everything, making the central property of the
 * architecture verifiable: **the core is the authority**. No client directly
 * reaches an executor; only one path exists, passing through here:
 *
 *     client ─▶ route or WebSocket ─▶ PermissionService ─▶ ConfirmationBroker
 *            ─▶ TaskCoordinator ─▶ DeviceSelector ─▶ WorkerGateway ─▶ worker
 *
 * Nothing is reimplemented: devices, device sessions, tasks, confirmations,
 * permissions, and memory come from existing packages. The API wires them
 * and exposes their surface.
 */

export interface ServiceContainerOptions {
  /** Token signing private key. Generated on deployment, never committed. */
  tokenPrivateKeyPem: string;
  now?: () => Date;
  prisma?: PrismaClient;

  /** Replaceable: Prisma persistence plugs in here without altering routes. */
  users?: UserStore;
  sessions?: SessionStore;
  conversations?: ConversationStore;
  notifications?: NotificationStore;
  memory?: MemoryProvider;
  credentials?: DeviceCredentialStore;
  taskStore?: TaskStore;
  deviceStore?: DeviceStore;
  /**
   * Pairing ticket store.
   *
   * If omitted, an in-memory store is mounted: tickets live five minutes,
   * so a restarted instance loses none that matter. In production, the
   * PostgreSQL store is supplied — otherwise a QR code displayed on the
   * dashboard would not be recognized by the process handling the scan
   * once more than one instance runs.
   */
  pairingTickets?: PairingTicketStore;
  /**
   * Public API address included in the pairing QR code.
   *
   * Optional; its absence has a clear consequence: QR pairing is rejected
   * with a message pointing to `PUBLIC_API_URL`. Producing a QR code with a
   * guessed address would be worse than rejecting — it would silently lead to
   * the wrong endpoint, and the failure would appear on the phone, far from the cause.
   */
  publicApiUrl?: string;
  /** Expected worker version. Advisory: see `@nexus/devices/updates`. */
  expectedWorkerVersion?: string;
  runStore?: QueryableAgentRunStore;
  telemetry?: NexusTelemetry;
  embeddings?: EmbeddingProvider;

  /**
   * Agent Core run claim registry.
   *
   * In-memory by default, suitable for tests and single-process deployments.
   * In production this must be backed by PostgreSQL: the database uniqueness
   * constraint enforces the guarantee, not a local in-process data structure.
   */
  agentRunClaims?: AgentRunClaimStore;

  /**
   * Mission assertion registry. In-memory by default; in production it is backed
   * by PostgreSQL, otherwise an API restart would render every assertion
   * unknown — thus rejected — breaking ongoing missions.
   */
  missionGrantRegistry?: MissionGrantRegistry;
  /** Durable schedule delegations, hashed in storage. */
  scheduleGrantRegistry?: ScheduleGrantRegistry;

  /** Assertion renewal threshold margin. Exposed for clock skew tests. */
  missionGrantRenewWithinMs?: number;

  /**
   * Device signature verifier.
   *
   * By default, the registered secret type decides: Ed25519 for workstations,
   * ECDSA P-256 for Android, whose keystore does not support Ed25519.
   */
  deviceVerifier?: SignatureVerifier;

  /** Risk threshold above which human confirmation is required. */
  confirmationThreshold?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

  /** Logging for interrupted plan executions. */
  onTaskError?: (error: unknown, taskId: string) => void;

  /** Password hashing parameters. Reduced in test suites only. */
  passwordParams?: ScryptParams;

  /**
   * Memory audit callback.
   *
   * Receives **what occurred, never the content**. Knowing a sensitive
   * memory was rejected is useful; copying it to logs would negate the rejection.
   */
  onMemoryAudit?: ConstructorParameters<typeof MemoryService>[0]["onAudit"];

  /** Tool catalog. Provided by agent service when present. */
  toolRegistry?: ToolRegistry;
  /** MCP manager. Omitted = no server configured, and reported as such. */
  mcp?: McpManager;
  /** Browser worker client. Omitted = unconfigured. */
  browser?: BrowserWorkerClient;
  /** Native browser session manager (browser-harness). */
  browserSessionManager?: BrowserSessionManager;
  /** External notification dispatcher (desktop, mobile push ntfy, webhooks). */
  notificationDispatcher?: NotificationDispatcher;
  /** Runtime configuration store, stored locally without plaintext secrets. */
  runtimeConfiguration?: RuntimeConfigurationStore;
  /** Keyring vault backed by Linux session keyring. */
  vault?: KeyringVault;
  /** NEXUS ACP/paper-trading engine client. */
  missionControl?: MissionControlPort;
  /** Version displayed in dashboard. */
  apiVersion?: string;
  /** Private local directory for redacted, bounded logs. */
  observabilityDirectory?: string;
  /** LLM provider for TaskPlanner. */
  llmProvider?: LLMProvider;
  /** Local CLI and ACP adapter discovery. Injectable for API tests. */
  connectionManager?: ConnectionCatalogService;
}

export class ServiceContainer {
  readonly tokens: TokenService;
  readonly auth: AuthService;

  readonly users: UserStore;
  readonly userSessions: SessionStore;
  readonly conversations: ConversationStore;
  readonly notificationStore: NotificationStore;
  readonly memory: MemoryProvider;
  /** Memory store policy wrapper. Routes call only this. */
  readonly memoryService: MemoryService;
  readonly shortTerm: ShortTermContext;
  readonly context: ContextAssembler;

  readonly deviceRegistry: DeviceRegistry;
  readonly deviceSessions: DeviceSessionService;
  readonly deviceCredentials: DeviceCredentialStore;
  readonly pairing: PairingService;
  readonly publicApiUrl: string | undefined;
  readonly expectedWorkerVersion: string | undefined;
  readonly pause: PauseSwitch;
  readonly selector: DeviceSelector;
  readonly router: EventRouter;
  readonly gateway: WorkerGateway;
  readonly taskStore: TaskStore;
  readonly coordinator: TaskCoordinator;

  readonly permissions: PermissionService;
  readonly confirmations: ConfirmationService;
  readonly confirmationBroker: ConfirmationBroker;
  readonly notifications: NotificationService;
  readonly supervisor: TaskSupervisor;

  // ── Observability ─────────────────────────────────────────────────────
  //
  // The tool catalog and run store live here even when the agent loop
  // is not yet wired into the API: `services/agent` populates them, and
  // the dashboard reads the correct objects. An empty store is honest;
  // an invented store would not have been.
  readonly toolRegistry: ToolRegistry;
  readonly runStore: QueryableAgentRunStore;
  readonly telemetry: NexusTelemetry;
  readonly agentRunClaims: AgentRunClaimStore;
  readonly missionGrants: MissionGrantService;
  readonly scheduleGrants: ScheduleGrantService;
  /** General-purpose agent loop wired to the same tools and safeguards. */
  readonly agentCore: AgentOrchestrator | undefined;
  readonly securityLog: SecurityLog;
  readonly logs: LogBuffer;
  readonly dashboard: DashboardService;

  /** MCP manager, when present. `undefined` = unconfigured. */
  readonly mcp: McpManager | undefined;
  /** Browser worker client, when present. */
  browser: BrowserWorkerClient | undefined;
  /** Local native browser session manager. */
  browserSessionManager: BrowserSessionManager | undefined;
  /** External notification dispatcher. */
  readonly notificationDispatcher: NotificationDispatcher | undefined;
  readonly runtimeConfiguration: RuntimeConfigurationStore | undefined;
  readonly providerAccounts: ProviderAccountService | undefined;
  readonly agentRouter: AgentRouter;
  readonly sharedArtifacts: SharedArtifactStore;
  readonly agentCollaboration: AgentCollaborationService;
  readonly vault: KeyringVault | undefined;
  /** NEXUS ACP/paper-trading engine, when configured. */
  readonly missionControl: MissionControlPort | undefined;
  /** LLM provider for task planning (optional). */
  readonly llmProvider: LLMProvider | undefined;
  /** Secret-free local connection catalogue and safe diagnostic probes. */
  readonly connections: ConnectionCatalogService;
  /** Hosted organization services. Undefined keeps personal mode dependency-free. */
  readonly tenantPlatform: TenantPlatformService | undefined;
  readonly tenantRealtime: TenantRealtimeHub;

  readonly #now: () => Date;
  readonly #browserToolNames = new Set<string>();

  constructor(options: ServiceContainerOptions) {
    this.llmProvider = options.llmProvider;
    this.connections = options.connectionManager ?? new LocalConnectionManager();
    this.tenantPlatform =
      options.prisma === undefined ? undefined : new TenantPlatformService(options.prisma);
    this.tenantRealtime = new TenantRealtimeHub();
    const now = options.now ?? (() => new Date());
    this.#now = now;

    this.tokens = new TokenService({ privateKeyPem: options.tokenPrivateKeyPem, now });

    this.users = options.users ?? new InMemoryUserStore(now);
    this.userSessions = options.sessions ?? new InMemorySessionStore();
    this.conversations = options.conversations ?? new InMemoryConversationStore(now);
    this.notificationStore = options.notifications ?? new InMemoryNotificationStore(now);
    this.memory =
      options.memory ??
      (options.prisma === undefined
        ? new InMemoryMemoryProvider()
        : new PostgresMemoryProvider({
            prisma: options.prisma,
            now,
            ...(options.embeddings === undefined ? {} : { embeddings: options.embeddings }),
          }));
    this.shortTerm = new ShortTermContext({ now });

    this.auth = new AuthService({
      users: this.users,
      sessions: this.userSessions,
      tokens: this.tokens,
      ...(options.passwordParams === undefined ? {} : { passwordParams: options.passwordParams }),
      now,
    });

    // ── Devices ──────────────────────────────────────────────────────────
    this.deviceRegistry = new DeviceRegistry({
      now,
      ...(options.deviceStore ? { store: options.deviceStore } : {}),
    });
    this.deviceCredentials = options.credentials ?? new InMemoryCredentialProvider();
    this.pairing = new PairingService({
      store: options.pairingTickets ?? new InMemoryPairingTicketStore(),
      now,
    });
    this.publicApiUrl = options.publicApiUrl;
    this.expectedWorkerVersion = options.expectedWorkerVersion;
    this.deviceSessions = new DeviceSessionService({
      registry: this.deviceRegistry,
      verifier: options.deviceVerifier ?? multiAlgorithmVerifier,
      now,
    });
    this.router = new EventRouter({ registry: this.deviceRegistry, now });
    this.gateway = new WorkerGateway({
      registry: this.deviceRegistry,
      sessions: this.deviceSessions,
      credentials: this.deviceCredentials,
      router: this.router,
      now,
    });
    this.selector = new DeviceSelector({ registry: this.deviceRegistry });

    // ── Global pause ──────────────────────────────────────────────────────
    //
    // Mounted before permissions: permissions query the pause switch.
    this.pause = new PauseSwitch({
      ...(options.runtimeConfiguration === undefined
        ? {}
        : { store: options.runtimeConfiguration }),
      now,
    });

    // ── Permissions and confirmations ─────────────────────────────────────
    this.permissions = new PermissionService({
      // Closure rather than value: pause takes effect on the next call,
      // without rebuilding the service or its dependents.
      readOnly: () => this.pause.paused,
      grants: {
        // Permissions granted to user are the union of those of their devices.
        // A machine granted `terminal.execute` makes the permission available;
        // selector decides *where* it is exercised.
        listGranted: async (userId) => {
          const devices = await this.deviceRegistry.listDevices(userId);
          return [...new Set(devices.flatMap((device) => device.grantedPermissions))];
        },
      },
    });

    this.confirmations = new ConfirmationService({
      store: new InMemoryConfirmationStore(),
      now,
    });

    this.notifications = new NotificationService({
      store: this.notificationStore,
      router: this.router,
      dispatcher: options.notificationDispatcher,
      now,
    });

    this.confirmationBroker = new ConfirmationBroker({
      confirmations: this.confirmations,
      notifications: this.notifications,
      now,
    });

    // ── Tasks ─────────────────────────────────────────────────────────────
    this.taskStore = options.taskStore ?? new InMemoryTaskStore();
    this.coordinator = new TaskCoordinator({
      registry: this.deviceRegistry,
      selector: this.selector,
      router: this.router,
      transport: this.gateway,
      store: this.taskStore,
      confirmations: this.confirmationBroker,
      ...(options.confirmationThreshold === undefined
        ? {}
        : { confirmationThreshold: options.confirmationThreshold }),
      now,
    });

    this.supervisor = new TaskSupervisor({
      coordinator: this.coordinator,
      notifications: this.notifications,
      ...(options.onTaskError === undefined ? {} : { onError: options.onTaskError }),
    });

    // ── Memory ────────────────────────────────────────────────────────────
    //
    // The service wraps the store; it is this wrapper, and only this wrapper,
    // that routes and agent core call. The raw store would write whatever is passed
    // — that is its role, and why it must not be reachable directly from a route.
    // The security log must exist before the memory service, which logs refusals to it.
    this.securityLog = new SecurityLog({
      now,
      ...(options.observabilityDirectory === undefined
        ? {}
        : { filePath: resolve(options.observabilityDirectory, "security.jsonl") }),
    });
    this.logs = new LogBuffer(
      options.observabilityDirectory === undefined
        ? {}
        : { filePath: resolve(options.observabilityDirectory, "application.jsonl") },
    );

    this.memoryService = new MemoryService({
      provider: this.memory,
      onAudit: (event) => {
        // A memory refusal is a security event: record that a secret almost entered
        // the database. Only categories are reported, never content — the log
        // must not retain what was just rejected.
        if (event.action === "refuse" || event.action === "consent-required") {
          this.securityLog.record({
            kind: event.action === "refuse" ? "memory.refused" : "memory.consent_required",
            userId: event.userId,
            summary:
              event.action === "refuse"
                ? `Memory storage refused (${(event.categories ?? []).join(", ")})`
                : `Consent required to store memory (${(event.categories ?? []).join(", ")})`,
            context: { categories: event.categories ?? [] },
          });
        }

        options.onMemoryAudit?.(event);
      },
    });

    // The assembler links all six layers without conflating them. The four sources
    // it does not own are wired here to their true owners: conversation store,
    // device registry, task store. Duplicating them would create divergent state.
    this.context = new ContextAssembler({
      memory: this.memory,
      shortTerm: this.shortTerm,
      conversation: {
        recentTurns: async (input) => {
          const conversation = await this.conversations.get(input.conversationId);
          if (conversation?.userId !== input.userId) return [];

          const page = await this.conversations.listMessages(input.conversationId, {
            limit: input.limit,
          });
          return page.items.map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          }));
        },
      },
      devices: {
        devicesFor: async (userId) => {
          const devices = await this.deviceRegistry.listDevices(userId);
          return devices.map((device) => ({
            id: device.id,
            name: device.name,
            role: device.role,
            status: device.status,
            capabilities: device.capabilities.filter((c) => c.enabled).map((c) => c.name),
          }));
        },
      },
      tasks: {
        recentTasks: async (input) => {
          const plans = await this.taskStore.listByUser(input.userId, input.limit);
          const devices = await this.deviceRegistry.listDevices(input.userId);
          const names = new Map(devices.map((device) => [device.id, device.name]));

          return plans.map((plan: TaskPlan) => {
            // Machine that executed the last retained step. An identifier teaches
            // nothing to the model; a name does.
            const executed = plan.steps.findLast((step) => step.selectedDeviceId !== null);
            const deviceId = executed?.selectedDeviceId ?? null;

            return {
              id: plan.id,
              title: plan.title,
              status: plan.status,
              completedAt: plan.completedAt === null ? null : new Date(plan.completedAt),
              deviceName: deviceId === null ? null : (names.get(deviceId) ?? null),
            };
          });
        },
      },
    });

    // ── Observability ─────────────────────────────────────────────────────
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.telemetry = options.telemetry ?? new NexusTelemetry();
    this.runStore = new ObservableAgentRunStore(
      options.runStore ?? new InMemoryAgentRunStore(),
      this.telemetry,
    );
    this.agentRunClaims = options.agentRunClaims ?? new InMemoryAgentRunClaimStore();
    this.missionGrants = new MissionGrantService({
      signer: this.tokens,
      registry: options.missionGrantRegistry ?? new InMemoryMissionGrantRegistry(),
      ...(options.missionGrantRenewWithinMs === undefined
        ? {}
        : { renewWithinMs: options.missionGrantRenewWithinMs }),
      now,
    });
    this.scheduleGrants = new ScheduleGrantService({
      registry: options.scheduleGrantRegistry ?? new InMemoryScheduleGrantRegistry(),
      missions: this.missionGrants,
      isUserActive: async (userId) => (await this.users.findById(userId))?.status === "ACTIVE",
      now,
    });
    this.agentCore =
      options.llmProvider === undefined
        ? undefined
        : new AgentOrchestrator({
            llm: options.llmProvider,
            registry: this.toolRegistry,
            permissions: this.permissions,
            confirmations: this.confirmations,
            context: this.context,
            store: this.runStore,
          });
    this.mcp = options.mcp;
    this.browser = undefined;
    this.browserSessionManager = undefined;
    if (options.browserSessionManager !== undefined) {
      this.setNativeBrowser(options.browserSessionManager);
    } else {
      this.setBrowser(options.browser);
    }
    this.runtimeConfiguration = options.runtimeConfiguration;
    this.providerAccounts =
      options.runtimeConfiguration === undefined
        ? undefined
        : new ProviderAccountService({
            runtimeConfiguration: options.runtimeConfiguration,
            now,
          });
    this.agentRouter = new AgentRouter({
      runtimeConfiguration: options.runtimeConfiguration,
      providerAccounts: this.providerAccounts,
      now,
    });
    this.sharedArtifacts = new SharedArtifactStore();
    this.agentCollaboration = new AgentCollaborationService();
    this.vault = options.vault;
    this.missionControl = options.missionControl;
    this.notificationDispatcher = options.notificationDispatcher;

    this.dashboard = new DashboardService({
      services: this,
      now,
      ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
    });
  }

  get now(): Date {
    return this.#now();
  }

  setBrowser(browser: BrowserWorkerClient | undefined): void {
    for (const name of this.#browserToolNames) this.toolRegistry.unregister(name);
    this.#browserToolNames.clear();
    this.browser = browser;
    this.browserSessionManager = undefined;
    if (browser === undefined) return;
    for (const tool of createBrowserTools({ client: browser })) {
      this.toolRegistry.register(tool, { replace: true });
      this.#browserToolNames.add(tool.name);
    }
  }

  setNativeBrowser(sessionManager: BrowserSessionManager | undefined): void {
    for (const name of this.#browserToolNames) this.toolRegistry.unregister(name);
    this.#browserToolNames.clear();
    this.browser = undefined;
    this.browserSessionManager = sessionManager;
    if (sessionManager === undefined) return;
    for (const tool of createNativeBrowserTools({ sessionManager })) {
      this.toolRegistry.register(tool, { replace: true });
      this.#browserToolNames.add(tool.name);
    }
  }

  /**
   * Effective permissions of a user.
   *
   * Queried before any task execution. This is where "the core is the authority"
   * stops being an intention: a step whose capability is not granted never leaves the server.
   */
  async permissionsFor(userId: string): Promise<string[]> {
    return [...(await this.permissions.listGranted(userId))];
  }
}

export interface QueryableAgentRunStore extends AgentRunStore {
  listAll(): Promise<AgentState[]>;
}

/**
 * Multi-algorithm verifier.
 *
 * A PEM public key does not state on its own which algorithm produced it from
 * the caller's perspective, but `crypto.verify` knows. We attempt Ed25519 then
 * ECDSA P-256: both coexist because Android cannot store Ed25519 keys in its hardware keystore.
 *
 * This is not a weakening: each attempt checks a genuine signature against a genuine key.
 * An invalid signature fails both.
 */
const multiAlgorithmVerifier: SignatureVerifier = (material, nonce, signature) =>
  ed25519Verifier(material, nonce, signature) || ecdsaP256Verifier(material, nonce, signature);

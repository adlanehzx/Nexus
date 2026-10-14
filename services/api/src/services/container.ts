import { TokenService, type ScryptParams } from "@nexus/auth";
import type { LLMProvider } from "@nexus/llm";
import {
  DeviceRegistry,
  DeviceSelector,
  DeviceSessionService,
  EventRouter,
  InMemoryCredentialProvider,
  InMemoryTaskStore,
  TaskCoordinator,
  WorkerGateway,
  ecdsaP256Verifier,
  ed25519Verifier,
  type DeviceCredentialProvider,
  type SignatureVerifier,
} from "@nexus/devices";
import {
  ConfirmationService,
  InMemoryConfirmationStore,
  PermissionService,
  ToolRegistry,
} from "@nexus/tools";
import { InMemoryAgentRunStore } from "@nexus/agent-core";
import type { McpManager } from "@nexus/mcp";
import type { BrowserWorkerClient } from "@nexus/browser-client";
import type { MissionControlPort } from "@nexus/mission-control-client";
import type { PrismaClient } from "@nexus/database";
import {
  ContextAssembler,
  InMemoryMemoryProvider,
  MemoryService,
  PostgresMemoryProvider,
  ShortTermContext,
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
import { TaskSupervisor } from "./task-supervisor.js";
import { LogBuffer, SecurityLog } from "./observability.js";
import { DashboardService } from "./dashboard.js";

/**
 * Assemblage des services de l'API.
 *
 * Un seul endroit relie tout, et c'est ce qui rend vérifiable la propriété
 * centrale de l'architecture : **le cœur est l'autorité**. Aucun client
 * n'atteint un exécutant ; il n'existe qu'un chemin, et il passe par ici.
 *
 *     client ─▶ route ou WebSocket ─▶ PermissionService ─▶ ConfirmationBroker
 *            ─▶ TaskCoordinator ─▶ DeviceSelector ─▶ WorkerGateway ─▶ worker
 *
 * Rien n'est réimplémenté : appareils, sessions d'appareil, tâches,
 * confirmations, permissions et mémoire viennent des paquets existants. L'API
 * les câble et expose leur surface.
 */

export interface ServiceContainerOptions {
  /** Clé de signature des jetons. Générée au déploiement, jamais commitée. */
  tokenPrivateKeyPem: string;
  now?: () => Date;
  prisma?: PrismaClient;

  /** Remplaçables : la persistance Prisma se branche ici sans toucher aux routes. */
  users?: UserStore;
  sessions?: SessionStore;
  conversations?: ConversationStore;
  notifications?: NotificationStore;
  memory?: MemoryProvider;
  credentials?: DeviceCredentialProvider;
  taskStore?: import("@nexus/devices").TaskStore;
  deviceStore?: import("@nexus/devices").DeviceStore;

  /**
   * Vérificateur de signature d'appareil.
   *
   * Par défaut, le type de secret enregistré décide : Ed25519 pour les postes
   * de travail, ECDSA P-256 pour Android, dont le magasin de clés ne gère pas
   * Ed25519.
   */
  deviceVerifier?: SignatureVerifier;

  /** Risque à partir duquel une confirmation humaine est exigée. */
  confirmationThreshold?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

  /** Journalisation d'une exécution de plan interrompue. */
  onTaskError?: (error: unknown, taskId: string) => void;

  /** Coût du hachage de mot de passe. Réduit dans les tests uniquement. */
  passwordParams?: ScryptParams;

  /**
   * Audit de la mémoire.
   *
   * Reçoit **ce qui s'est passé, jamais le contenu**. Savoir qu'un souvenir
   * sensible a été refusé est utile ; le recopier dans le journal annulerait le
   * refus.
   */
  onMemoryAudit?: ConstructorParameters<typeof MemoryService>[0]["onAudit"];

  /** Catalogue d'outils. Fourni par le service agent quand il existe. */
  toolRegistry?: ToolRegistry;
  /** Gestionnaire MCP. Absent = aucun serveur configure, et le dire. */
  mcp?: McpManager;
  /** Client du worker navigateur. Absent = non configure. */
  browser?: BrowserWorkerClient;
  /** Client du moteur OpenHands ACP/paper-trading. */
  missionControl?: MissionControlPort;
  /** Version affichee par le tableau de bord. */
  apiVersion?: string;
  /** Provider LLM pour le TaskPlanner. */
  llmProvider?: LLMProvider;
}

export class ServiceContainer {
  readonly tokens: TokenService;
  readonly auth: AuthService;

  readonly users: UserStore;
  readonly userSessions: SessionStore;
  readonly conversations: ConversationStore;
  readonly notificationStore: NotificationStore;
  readonly memory: MemoryProvider;
  /** La politique autour du magasin. Les routes n'appellent que celle-ci. */
  readonly memoryService: MemoryService;
  readonly shortTerm: ShortTermContext;
  readonly context: ContextAssembler;

  readonly deviceRegistry: DeviceRegistry;
  readonly deviceSessions: DeviceSessionService;
  readonly deviceCredentials: DeviceCredentialProvider;
  readonly selector: DeviceSelector;
  readonly router: EventRouter;
  readonly gateway: WorkerGateway;
  readonly taskStore: import("@nexus/devices").TaskStore;
  readonly coordinator: TaskCoordinator;

  readonly permissions: PermissionService;
  readonly confirmations: ConfirmationService;
  readonly confirmationBroker: ConfirmationBroker;
  readonly notifications: NotificationService;
  readonly supervisor: TaskSupervisor;

  // ── Observabilite ─────────────────────────────────────────────────────
  //
  // Le catalogue d'outils et le magasin de runs vivent ici meme si la boucle
  // agent n'est pas encore cablee dans l'API : ce sont eux que `services/agent`
  // remplira, et le tableau de bord lit deja les bons objets. Un magasin vide
  // est honnete ; un magasin invente ne l'aurait pas ete.
  readonly toolRegistry: ToolRegistry;
  readonly runStore: InMemoryAgentRunStore;
  readonly securityLog: SecurityLog;
  readonly logs: LogBuffer;
  readonly dashboard: DashboardService;

  /** Gestionnaire MCP, quand il y en a un. `undefined` = non configure. */
  readonly mcp: McpManager | undefined;
  /** Client du worker navigateur, quand il y en a un. */
  readonly browser: BrowserWorkerClient | undefined;
  /** Moteur OpenHands ACP/paper-trading, quand il est configuré. */
  readonly missionControl: MissionControlPort | undefined;
  /** Provider LLM pour planifier des tâches (optionnel). */
  readonly llmProvider: LLMProvider | undefined;

  readonly #now: () => Date;

  constructor(options: ServiceContainerOptions) {
    this.llmProvider = options.llmProvider;
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
        : new PostgresMemoryProvider({ prisma: options.prisma, now }));
    this.shortTerm = new ShortTermContext({ now });

    this.auth = new AuthService({
      users: this.users,
      sessions: this.userSessions,
      tokens: this.tokens,
      ...(options.passwordParams === undefined ? {} : { passwordParams: options.passwordParams }),
      now,
    });

    // ── Appareils ─────────────────────────────────────────────────────────
    this.deviceRegistry = new DeviceRegistry({
      now,
      ...(options.deviceStore ? { store: options.deviceStore } : {}),
    });
    this.deviceCredentials = options.credentials ?? new InMemoryCredentialProvider();
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

    // ── Permissions et confirmations ──────────────────────────────────────
    this.permissions = new PermissionService({
      grants: {
        // Les permissions accordées à l'utilisateur sont l'union de celles de
        // ses appareils. Un poste autorisé à `terminal.execute` rend la
        // permission disponible ; le sélecteur décidera *où* elle s'exerce.
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
      now,
    });

    this.confirmationBroker = new ConfirmationBroker({
      confirmations: this.confirmations,
      now,
    });

    // ── Tâches ────────────────────────────────────────────────────────────
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

    // ── Mémoire ───────────────────────────────────────────────────────────
    //
    // Le service enveloppe le magasin ; c'est lui, et lui seul, que les routes
    // et le cœur agent appellent. Le magasin nu écrirait tout ce qu'on lui
    // donne — c'est son rôle, et c'est pourquoi il ne doit pas être atteignable
    // directement depuis une route.
    // Le journal de securite doit exister avant le service de memoire, qui lui
    // remonte ses refus.
    this.securityLog = new SecurityLog({ now });
    this.logs = new LogBuffer();

    this.memoryService = new MemoryService({
      provider: this.memory,
      onAudit: (event) => {
        // Un refus de memorisation est un evenement de securite : c'est la
        // trace qu'un secret a failli entrer dans la base. Seules les
        // **categories** remontent, jamais le contenu — le journal ne doit pas
        // conserver ce qu'on vient de refuser de conserver.
        if (event.action === "refuse" || event.action === "consent-required") {
          this.securityLog.record({
            kind: event.action === "refuse" ? "memory.refused" : "memory.consent_required",
            userId: event.userId,
            summary:
              event.action === "refuse"
                ? `Memorisation refusee (${(event.categories ?? []).join(", ")})`
                : `Accord requis pour memoriser (${(event.categories ?? []).join(", ")})`,
            context: { categories: event.categories ?? [] },
          });
        }

        options.onMemoryAudit?.(event);
      },
    });

    // L'assembleur relie les six couches sans les mélanger. Les quatre sources
    // qu'il ne possède pas sont branchées ici, sur leurs vrais propriétaires :
    // le magasin de conversations, le registre d'appareils, le magasin de
    // plans. Les recopier créerait une seconde vérité, qui divergerait.
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
          const plans = await (this.taskStore as any).listByUser(input.userId, input.limit);
          const devices = await this.deviceRegistry.listDevices(input.userId);
          const names = new Map(devices.map((device) => [device.id, device.name]));

          return plans.map((plan: any) => {
            // La machine qui a exécuté la dernière étape retenue. Un
            // identifiant n'apprend rien au modèle ; un nom, si.
            const executed = plan.steps.findLast((step: any) => step.selectedDeviceId !== null);
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

    // ── Observabilite ─────────────────────────────────────────────────────
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.runStore = new InMemoryAgentRunStore();
    this.mcp = options.mcp;
    this.browser = options.browser;
    this.missionControl = options.missionControl;

    this.dashboard = new DashboardService({
      services: this,
      now,
      ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
    });
  }

  get now(): Date {
    return this.#now();
  }

  /**
   * Permissions effectives d'un utilisateur.
   *
   * Consultées avant toute exécution de tâche. C'est le point où « le cœur est
   * l'autorité » cesse d'être une intention : une étape dont la capacité n'est
   * pas accordée ne quitte jamais le serveur.
   */
  async permissionsFor(userId: string): Promise<string[]> {
    return [...(await this.permissions.listGranted(userId))];
  }
}

/**
 * Vérificateur multi-algorithme.
 *
 * Une clé publique PEM ne dit pas d'elle-même quel algorithme l'a produite du
 * point de vue de l'appelant, mais `crypto.verify` le sait. On essaie Ed25519
 * puis ECDSA P-256 : les deux coexistent parce qu'Android ne sait pas stocker de
 * clé Ed25519 dans son magasin matériel.
 *
 * Ce n'est pas un affaiblissement : chaque tentative vérifie une vraie
 * signature contre une vraie clé. Une signature invalide échoue aux deux.
 */
const multiAlgorithmVerifier: SignatureVerifier = (material, nonce, signature) =>
  ed25519Verifier(material, nonce, signature) || ecdsaP256Verifier(material, nonce, signature);

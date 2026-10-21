import type { SessionManager } from "./session.js";

/**
 * Appels REST du client.
 *
 * Toutes les requêtes passent par `SessionManager.authorizedRequest`, qui gère
 * le rafraîchissement transparent. Ce fichier ne fait que nommer les routes et
 * typer les réponses — dupliquer la logique de jeton ici la ferait diverger au
 * premier correctif.
 *
 * Ce que l'API sert et que le temps réel ne sert pas : **l'historique**. Le
 * canal WebSocket porte ce qui arrive maintenant ; l'API porte ce qui est arrivé
 * avant que l'application ne s'ouvre.
 */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface ApiDevice {
  id: string;
  name: string;
  type: string;
  platform: string;
  role: string;
  status: string;
  trust: string;
  capabilities: string[];
  grantedPermissions: string[];
  health: {
    activeTasks: number;
    maxConcurrentTasks: number;
    batteryPercent?: number;
    onBattery?: boolean;
  };
  lastSeenAt: string | null;
  authenticated: boolean;
}

export interface ApiTask {
  id: string;
  title: string;
  status: string;
  originClientDeviceId: string;
  steps: {
    id: string;
    description: string;
    status: string;
    selectedDeviceId: string | null;
    riskLevel: string;
    error: { code: string; message: string } | null;
  }[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ApiConversation {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  originClientDeviceId: string | null;
  createdAt: string;
}

export interface ApiMemory {
  id: string;
  content: string;
  layer: string;
  kind: string;
  origin: string;
  importance: number;
  confidence: number;
  tags: string[];
  sensitivity: string;
  sensitiveCategories: string[];
  createdAt: string;
  supersedesId: string | null;
}

export interface ApiMemoryHit {
  id: string;
  content: string;
  kind: string;
  layer: string;
  origin: string;
  sensitivity: string;
  score: number;
}

/** Ce que le cœur répond à « Retiens que… » ou « Oublie… ». */
export interface ApiMemoryCommandResult {
  recognized: boolean;
  kind: "remember" | "forget" | null;
  message: string;
  stored: ApiMemory | null;
  forgotten: ApiMemory[];
  ambiguous: ApiMemory[];
  needsConfirmation: boolean;
}

export interface ApiNotification {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  readAt: string | null;
  createdAt: string;
}

export class ApiClient {
  readonly #session: SessionManager;

  constructor(session: SessionManager) {
    this.#session = session;
  }

  async listDevices(): Promise<ApiDevice[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: "/api/v1/devices?limit=100",
    });
    return this.#unwrapList<ApiDevice>(response.status, response.body);
  }

  async trustDevice(deviceId: string): Promise<ApiDevice> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/devices/${deviceId}/trust`,
    });
    return this.#unwrap<ApiDevice>(response.status, response.body);
  }

  async revokeDevice(deviceId: string): Promise<ApiDevice> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/devices/${deviceId}/revoke`,
    });
    return this.#unwrap<ApiDevice>(response.status, response.body);
  }

  async setDevicePermissions(deviceId: string, permissions: string[]): Promise<ApiDevice> {
    const response = await this.#session.authorizedRequest({
      method: "PATCH",
      path: `/api/v1/devices/${deviceId}/permissions`,
      body: { grantedPermissions: permissions },
    });
    return this.#unwrap<ApiDevice>(response.status, response.body);
  }

  /**
   * Transmet une instruction en langage naturel au cœur.
   *
   * **C'est le seul chemin par lequel un client déclenche une action.** Le
   * client ne planifie pas et n'exécute pas : il transmet la phrase, et le
   * cœur enchaîne planificateur → autorisation → superviseur → exécutant.
   * Ce que cette méthode rend, c'est le plan **déjà autorisé** ; la suite
   * arrive par le canal temps réel.
   *
   * Le corps ne désigne aucun exécutant, aucune capacité, aucun outil. « Ouvre
   * Chrome sur mon PC » part tel quel : c'est le sélecteur du cœur qui choisit
   * la machine, et les permissions de l'utilisateur qui décident si elle a le
   * droit. Un client qui composerait lui-même le plan court-circuiterait le
   * planificateur — et deviendrait un second cœur.
   *
   * **Aucun réessai automatique.** Un délai dépassé ne dit pas si le cœur a
   * reçu l'instruction ; renvoyer « achète ce billet » dans le doute créerait
   * une seconde commande. L'appelant qui veut réessayer le décide, après avoir
   * regardé ses tâches.
   */
  async instruct(input: {
    instruction: string;
    originClientDeviceId: string;
    conversationId?: string;
  }): Promise<ApiTask> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/tasks/instruct",
      body: {
        instruction: input.instruction,
        originClientDeviceId: input.originClientDeviceId,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      },
    });
    return this.#unwrap<ApiTask>(response.status, response.body);
  }

  async getTask(taskId: string): Promise<ApiTask> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/tasks/${taskId}`,
    });
    return this.#unwrap<ApiTask>(response.status, response.body);
  }

  async cancelTask(taskId: string, reason: string): Promise<boolean> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/tasks/${taskId}/cancel`,
      body: { reason },
    });
    return this.#unwrap<{ cancelled: boolean }>(response.status, response.body).cancelled;
  }

  async listNotifications(unreadOnly = false): Promise<ApiNotification[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/notifications?limit=50&unreadOnly=${String(unreadOnly)}`,
    });
    return this.#unwrapList<ApiNotification>(response.status, response.body);
  }

  async markNotificationRead(notificationId: string): Promise<ApiNotification> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/notifications/${notificationId}/read`,
    });
    return this.#unwrap<ApiNotification>(response.status, response.body);
  }

  async listConversations(): Promise<ApiConversation[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: "/api/v1/conversations?limit=50",
    });
    return this.#unwrapList<ApiConversation>(response.status, response.body);
  }

  async listMessages(conversationId: string): Promise<ApiMessage[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/conversations/${conversationId}/messages?limit=100`,
    });
    return this.#unwrapList<ApiMessage>(response.status, response.body);
  }

  /**
   * Crée un plan de tâche.
   *
   * `body` ne contient **jamais** d'exécutant : il décrit des capacités
   * requises, et le cœur choisit la machine. C'est la raison pour laquelle il
   * n'existe pas de surcharge « exécuter sur tel appareil » — une telle méthode
   * ferait du client l'ordonnanceur, et le cœur un simple relais.
   */
  async createTask(body: {
    title: string;
    originClientDeviceId: string;
    conversationId?: string;
    steps: {
      id?: string;
      description: string;
      requiredCapabilities: string[];
      tool: string;
      arguments?: Record<string, unknown>;
      dependsOn: string[];
      riskLevel?: string;
    }[];
  }): Promise<ApiTask> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/tasks",
      body,
    });
    return this.#unwrap<ApiTask>(response.status, response.body);
  }

  /** Capacités connues du cœur, tous exécutants confondus. */
  async listCapabilities(): Promise<{ name: string; description: string; riskLevel: string }[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: "/api/v1/capabilities",
    });
    return this.#unwrapList(response.status, response.body);
  }

  async searchMemory(query: string, limit = 10): Promise<ApiMemoryHit[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/memory/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`,
    });
    return this.#unwrap<{ hits: ApiMemoryHit[] }>(response.status, response.body).hits;
  }

  /** Tout ce que NEXUS retient, du plus récent au plus ancien. */
  async listMemory(layer?: "LONG_TERM" | "PREFERENCE"): Promise<ApiMemory[]> {
    const suffix = layer === undefined ? "" : `&layer=${layer}`;
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/memory?limit=200${suffix}`,
    });
    return this.#unwrapList<ApiMemory>(response.status, response.body);
  }

  /**
   * Enregistre un souvenir.
   *
   * `acknowledgedSensitive` n'a **aucune valeur par défaut à `true`**, ici comme
   * partout : c'est ce qui donne son sens à la règle. L'interface le passe après
   * avoir posé la question, jamais avant.
   */
  async storeMemory(input: {
    content: string;
    kind?: string;
    layer?: "LONG_TERM" | "PREFERENCE";
    tags?: string[];
    acknowledgedSensitive?: boolean;
  }): Promise<ApiMemory> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/memory",
      body: {
        content: input.content,
        kind: input.kind ?? "SEMANTIC",
        layer: input.layer ?? "LONG_TERM",
        tags: input.tags ?? [],
        acknowledgedSensitive: input.acknowledgedSensitive ?? false,
      },
    });
    return this.#unwrap<ApiMemory>(response.status, response.body);
  }

  async updateMemory(
    memoryId: string,
    patch: {
      content?: string;
      importance?: number;
      tags?: string[];
      layer?: "LONG_TERM" | "PREFERENCE";
      acknowledgedSensitive?: boolean;
    },
  ): Promise<ApiMemory> {
    const response = await this.#session.authorizedRequest({
      method: "PATCH",
      path: `/api/v1/memory/${memoryId}`,
      body: { ...patch, acknowledgedSensitive: patch.acknowledgedSensitive ?? false },
    });
    return this.#unwrap<ApiMemory>(response.status, response.body);
  }

  async forgetMemory(memoryId: string): Promise<ApiMemory[]> {
    const response = await this.#session.authorizedRequest({
      method: "DELETE",
      path: `/api/v1/memory/${memoryId}`,
    });
    return this.#unwrap<{ forgotten: ApiMemory[] }>(response.status, response.body).forgotten;
  }

  /** Efface toute la mémoire. `confirmed` est exigé — cela ne se défait pas. */
  async forgetAllMemory(
    confirmed: boolean,
  ): Promise<{ forgotten: ApiMemory[]; needsConfirmation: boolean }> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/memory/forget",
      body: { all: true, confirmed },
    });
    return this.#unwrap(response.status, response.body);
  }

  /** Soumet un message au cas où ce serait « Retiens que… » ou « Oublie… ». */
  async memoryCommand(
    text: string,
    options: { acknowledgedSensitive?: boolean; confirmedForgetAll?: boolean } = {},
  ): Promise<ApiMemoryCommandResult> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/memory/command",
      body: {
        text,
        acknowledgedSensitive: options.acknowledgedSensitive ?? false,
        confirmedForgetAll: options.confirmedForgetAll ?? false,
      },
    });
    return this.#unwrap<ApiMemoryCommandResult>(response.status, response.body);
  }

  async respondToConfirmation(
    confirmationId: string,
    decision: "approved" | "rejected",
  ): Promise<boolean> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/confirmations/${confirmationId}/respond`,
      body: { decision },
    });
    return this.#unwrap<{ accepted: boolean }>(response.status, response.body).accepted;
  }

  /**
   * Extrait `data`, ou lève avec le message du serveur.
   *
   * Le message du serveur est déjà sûr à afficher — c'est `userMessage`, qui ne
   * porte ni chemin ni détail interne. Le réécrire ici ferait perdre une
   * information utile à l'utilisateur.
   */
  #unwrap<T>(status: number, body: unknown): T {
    if (status >= 200 && status < 300) return (body as { data: T }).data;
    throw new Error(this.#messageOf(body));
  }

  #unwrapList<T>(status: number, body: unknown): T[] {
    if (status >= 200 && status < 300) return (body as { data: T[] }).data;
    throw new Error(this.#messageOf(body));
  }

  #messageOf(body: unknown): string {
    if (body !== null && typeof body === "object" && "error" in body) {
      const error = body.error;
      if (error !== null && typeof error === "object" && "message" in error) {
        return String(error.message);
      }
    }
    return "The request failed.";
  }
}

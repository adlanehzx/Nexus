import { SERVER_TO_CLIENT, type ServerToClientType } from "@nexus/protocol";

/**
 * L'état affiché par l'iPhone.
 *
 * Un **réducteur pur** : une trame entre, un nouvel état sort. Aucune requête,
 * aucun effet, aucune horloge implicite. Trois conséquences :
 *
 *  1. il se teste entièrement, sans simulateur ni serveur ;
 *  2. rejouer une file d'événements après reconnexion produit exactement l'état
 *     qu'on aurait eu en restant connecté — c'est ce qui fait converger l'iPhone
 *     et le portable au lieu de les faire diverger ;
 *  3. une trame inconnue laisse l'état **inchangé**, plutôt que de casser.
 *
 * Ce que le magasin ne fait pas : décider. Il n'annule rien, n'approuve rien,
 * n'envoie rien. Il décrit ce que le cœur a dit.
 */

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_for_confirmation"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  /** Progression du plan entier, de 0 à 100. */
  percent: number;
  /** Ce que fait l'étape en cours, en clair. */
  label: string | null;
  /** Appareil qui exécute l'étape courante, quand le cœur l'a dit. */
  workerDeviceId: string | null;
  /** Appareil d'où la demande est partie. Préservé de bout en bout. */
  originClientDeviceId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: { code: string; message: string } | null;
  stepCount: number;
}

export interface ToolCallView {
  callId: string;
  runId: string;
  tool: string;
  /** Résumé lisible. Le magasin ne reçoit jamais les arguments bruts. */
  summary: string;
  riskLevel: string;
  status: "running" | "succeeded" | "failed";
  percent: number | null;
  label: string | null;
  durationMs: number | null;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Vrai tant que le flux n'est pas terminé. */
  streaming: boolean;
  createdAt: string;
  originClientDeviceId: string | null;
}

export interface DeviceView {
  id: string;
  name: string;
  role: string;
  status: string;
  capabilities: string[];
  lastSeenAt: string | null;
}

export interface NotificationView {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  readAt: string | null;
  createdAt: string;
}

export interface ConfirmationView {
  id: string;
  taskId: string | null;
  capability: string | null;
  action: string;
  description: string;
  riskLevel: string;
  expiresAt: string;
  /** Passe à `true` dès que l'utilisateur a tranché — évite un double envoi. */
  answered: boolean;
}

export type ConnectionState =
  "offline" | "connecting" | "authenticating" | "connected" | "reconnecting";

export interface ClientState {
  connection: ConnectionState;
  /** Réseau de l'appareil. Distinct de la connexion au cœur. */
  online: boolean;
  messages: MessageView[];
  tasks: TaskView[];
  toolCalls: ToolCallView[];
  devices: DeviceView[];
  notifications: NotificationView[];
  confirmations: ConfirmationView[];
  /** Dernière erreur affichable. Effacée par l'interface après lecture. */
  lastError: { code: string; message: string; at: string } | null;
}

export const initialState: ClientState = {
  connection: "offline",
  online: true,
  messages: [],
  tasks: [],
  toolCalls: [],
  devices: [],
  notifications: [],
  confirmations: [],
  lastError: null,
};

export type ClientAction =
  | { kind: "connection"; state: ConnectionState }
  | { kind: "network"; online: boolean }
  | { kind: "server"; type: ServerToClientType; payload: Record<string, unknown> }
  | { kind: "localMessage"; message: MessageView }
  | { kind: "devices"; devices: DeviceView[] }
  /**
   * État d'une tâche relu auprès du cœur.
   *
   * Sert au rattrapage après reconnexion : le canal temps réel ne rejoue rien,
   * et une tâche achevée pendant une coupure resterait affichée « en cours ».
   * Le cœur est l'autorité ; cette action porte ce qu'il a dit.
   */
  | {
      kind: "taskSync";
      task: {
        id: string;
        title: string;
        status: string;
        startedAt: string | null;
        completedAt: string | null;
        stepCount: number;
        originClientDeviceId: string | null;
        error: { code: string; message: string } | null;
      };
    }
  | { kind: "confirmationAnswered"; confirmationId: string }
  | { kind: "notificationRead"; notificationId: string; at: string }
  | { kind: "error"; code: string; message: string; at: string }
  | { kind: "clearError" }
  | { kind: "reset" };

/**
 * Applique une action.
 *
 * Aucune mutation : chaque branche produit un nouvel objet. C'est ce qui permet
 * à React de savoir quoi redessiner, et ce qui rend un test lisible — on compare
 * deux états, pas des effets de bord.
 */
export function reduce(state: ClientState, action: ClientAction): ClientState {
  switch (action.kind) {
    case "connection":
      return { ...state, connection: action.state };

    case "network":
      return {
        ...state,
        online: action.online,
        // Perdre le réseau ne « déconnecte » pas au sens du cœur : la socket
        // tombera d'elle-même. Mais l'interface doit le dire tout de suite,
        // sinon l'utilisateur attend une réponse qui ne viendra pas.
        connection: action.online ? state.connection : "offline",
      };

    case "localMessage":
      return { ...state, messages: [...state.messages, action.message] };

    case "devices":
      return { ...state, devices: action.devices };

    case "taskSync": {
      const sync = action.task;

      // Le statut vient du cœur, qui utilise exactement la même énumération que
      // cet écran (`taskStatusSchema` de `@nexus/devices`). Un statut inconnu
      // serait donc un serveur plus récent que ce client : on garde l'ancien
      // plutôt que d'afficher un état inventé.
      const status = isTaskStatus(sync.status) ? sync.status : undefined;

      return upsertTask(state, sync.id, (task) => ({
        ...task,
        title: sync.title.length > 0 ? sync.title : task.title,
        status: status ?? task.status,
        // Une tâche rattrapée en état terminal est à 100 % : la dernière trame
        // de progression, elle, n'est jamais arrivée.
        percent: status !== undefined && !isActive(status) ? 100 : task.percent,
        label: status !== undefined && !isActive(status) ? null : task.label,
        stepCount: sync.stepCount > 0 ? sync.stepCount : task.stepCount,
        originClientDeviceId: sync.originClientDeviceId ?? task.originClientDeviceId,
        startedAt: sync.startedAt ?? task.startedAt,
        completedAt: sync.completedAt ?? task.completedAt,
        error: sync.error ?? task.error,
      }));
    }

    case "confirmationAnswered":
      return {
        ...state,
        confirmations: state.confirmations.map((confirmation) =>
          confirmation.id === action.confirmationId
            ? { ...confirmation, answered: true }
            : confirmation,
        ),
      };

    case "notificationRead":
      return {
        ...state,
        notifications: state.notifications.map((notification) =>
          notification.id === action.notificationId
            ? { ...notification, readAt: notification.readAt ?? action.at }
            : notification,
        ),
      };

    case "error":
      return {
        ...state,
        lastError: { code: action.code, message: action.message, at: action.at },
      };

    case "clearError":
      return { ...state, lastError: null };

    case "reset":
      return { ...initialState, online: state.online };

    case "server":
      return applyServerMessage(state, action.type, action.payload);
  }
}

function applyServerMessage(
  state: ClientState,
  type: ServerToClientType,
  payload: Record<string, unknown>,
): ClientState {
  switch (type) {
    // ── Conversation ────────────────────────────────────────────────────
    case SERVER_TO_CLIENT.messageDelta: {
      const messageId = str(payload, "messageId");
      const delta = str(payload, "delta");
      const done = bool(payload, "done");

      const existing = state.messages.find((message) => message.id === messageId);

      // Le premier fragment crée le message. Attendre un « début de flux »
      // explicite ajouterait un aller-retour pour rien, et un fragment perdu
      // laisserait le message invisible.
      if (existing === undefined) {
        return {
          ...state,
          messages: [
            ...state.messages,
            {
              id: messageId,
              role: "assistant",
              content: delta,
              streaming: !done,
              createdAt: nowFrom(payload),
              originClientDeviceId: asStringOrNull(payload.originClientDeviceId),
            },
          ],
        };
      }

      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === messageId
            ? { ...message, content: message.content + delta, streaming: !done }
            : message,
        ),
      };
    }

    // ── Tâches ──────────────────────────────────────────────────────────
    case SERVER_TO_CLIENT.taskCreated:
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        title: str(payload, "title", "Tache"),
        stepCount: num(payload, "stepCount", 1),
        status: "pending",
        originClientDeviceId: asStringOrNull(payload.originClientDeviceId),
        startedAt: nowFrom(payload),
      }));

    case SERVER_TO_CLIENT.taskProgress:
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        status: "running",
        percent: num(payload, "percent", task.percent),
        label: asStringOrNull(payload.label) ?? task.label,
        // On ne remplace jamais un exécutant connu par `null` : une trame de
        // progression sans appareil — étape refusée, plan sans exécutant —
        // effacerait sinon l'information affichée pour l'étape précédente.
        workerDeviceId: asStringOrNull(payload.deviceId) ?? task.workerDeviceId,
      }));

    case SERVER_TO_CLIENT.taskCompleted:
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        status: payload.status === "partial" ? "partial" : "succeeded",
        percent: 100,
        durationMs: num(payload, "durationMs", 0),
        completedAt: nowFrom(payload),
        label: null,
      }));

    case SERVER_TO_CLIENT.taskCancelled:
      // Une tâche annulée est **terminée**, pas en échec : elle quitte la liste
      // des actives, et l'interface ne propose pas de la relancer comme si
      // quelque chose s'était mal passé.
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        status: "cancelled",
        completedAt: nowFrom(payload),
        label: str(payload, "reason", "annulée"),
      }));

    case SERVER_TO_CLIENT.taskFailed:
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        status: "failed",
        completedAt: nowFrom(payload),
        error: {
          code: str(payload, "code", "UNKNOWN"),
          message: str(payload, "message", "La tâche a échoué."),
        },
      }));

    // ── Outils ──────────────────────────────────────────────────────────
    case SERVER_TO_CLIENT.toolStarted:
      return upsertToolCall(state, str(payload, "callId"), (call) => ({
        ...call,
        runId: str(payload, "runId"),
        tool: str(payload, "tool"),
        summary: str(payload, "summary"),
        riskLevel: str(payload, "riskLevel", "MEDIUM"),
        status: "running",
      }));

    case SERVER_TO_CLIENT.toolProgress:
      return upsertToolCall(state, str(payload, "callId"), (call) => ({
        ...call,
        percent: asNumberOrNull(payload.percent) ?? call.percent,
        label: asStringOrNull(payload.label) ?? call.label,
      }));

    case SERVER_TO_CLIENT.toolCompleted:
      return upsertToolCall(state, str(payload, "callId"), (call) => ({
        ...call,
        status: bool(payload, "ok") ? "succeeded" : "failed",
        summary: str(payload, "summary", call.summary),
        durationMs: num(payload, "durationMs", 0),
        percent: 100,
      }));

    // ── Confirmations ───────────────────────────────────────────────────
    case SERVER_TO_CLIENT.confirmationRequired: {
      const id = str(payload, "confirmationId");
      // Une demande reçue deux fois — reconnexion, file rejouée — ne doit pas
      // produire deux cartes à approuver.
      if (state.confirmations.some((confirmation) => confirmation.id === id)) return state;

      return {
        ...state,
        confirmations: [
          ...state.confirmations,
          {
            id,
            taskId: asStringOrNull(payload.taskId),
            capability: asStringOrNull(payload.capability),
            action: str(payload, "action"),
            description: str(payload, "description"),
            riskLevel: str(payload, "riskLevel", "MEDIUM"),
            expiresAt: str(payload, "expiresAt"),
            answered: false,
          },
        ],
      };
    }

    // ── Appareils ───────────────────────────────────────────────────────
    case SERVER_TO_CLIENT.deviceUpdated: {
      const id = str(payload, "deviceId");
      // Chaque champ n'est repris que s'il est reellement present : une trame
      // partielle ne doit pas effacer ce qu'elle ne mentionne pas.
      const name = asStringOrNull(payload.deviceName) ?? asStringOrNull(payload.name);
      const status = asStringOrNull(payload.status);
      const role = asStringOrNull(payload.role);
      const capabilities = strings(payload, "capabilities");

      const patch: Partial<DeviceView> = {
        ...(name === null ? {} : { name }),
        ...(status === null ? {} : { status }),
        ...(role === null ? {} : { role }),
        ...(capabilities === undefined ? {} : { capabilities }),
      };

      const existing = state.devices.find((device) => device.id === id);
      if (existing === undefined) {
        return {
          ...state,
          devices: [
            ...state.devices,
            {
              id,
              name: patch.name ?? id,
              role: patch.role ?? "WORKER",
              status: patch.status ?? "OFFLINE",
              capabilities: patch.capabilities ?? [],
              lastSeenAt: nowFrom(payload),
            },
          ],
        };
      }

      return {
        ...state,
        devices: state.devices.map((device) =>
          device.id === id ? { ...device, ...patch, lastSeenAt: nowFrom(payload) } : device,
        ),
      };
    }

    // ── Notifications ───────────────────────────────────────────────────
    case SERVER_TO_CLIENT.notificationCreated: {
      const id = str(payload, "notificationId");
      if (state.notifications.some((notification) => notification.id === id)) return state;

      return {
        ...state,
        notifications: [
          {
            id,
            title: str(payload, "title"),
            body: str(payload, "body"),
            severity: asSeverity(payload.severity),
            readAt: null,
            createdAt: nowFrom(payload),
          },
          ...state.notifications,
        ],
      };
    }

    default:
      // Type connu du protocole mais sans effet sur l'état — `client.ack`,
      // `agent.started`. Ou type inconnu d'un serveur plus récent. Dans les deux
      // cas, l'état ne bouge pas.
      return state;
  }
}

/** Crée la tâche si elle est inconnue, la met à jour sinon. */
function upsertTask(
  state: ClientState,
  taskId: string,
  patch: (task: TaskView) => TaskView,
): ClientState {
  const existing = state.tasks.find((task) => task.id === taskId);

  // Une tâche peut arriver par sa progression : l'iPhone était éteint quand
  // elle a démarré. Elle doit apparaître quand même.
  const base: TaskView = existing ?? {
    id: taskId,
    title: "Tâche",
    status: "pending",
    percent: 0,
    label: null,
    workerDeviceId: null,
    originClientDeviceId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
    stepCount: 1,
  };

  const updated = patch(base);

  return {
    ...state,
    tasks:
      existing === undefined
        ? [updated, ...state.tasks]
        : state.tasks.map((task) => (task.id === taskId ? updated : task)),
  };
}

function upsertToolCall(
  state: ClientState,
  callId: string,
  patch: (call: ToolCallView) => ToolCallView,
): ClientState {
  const existing = state.toolCalls.find((call) => call.callId === callId);

  const base: ToolCallView = existing ?? {
    callId,
    runId: "",
    tool: "",
    summary: "",
    riskLevel: "MEDIUM",
    status: "running",
    percent: null,
    label: null,
    durationMs: null,
  };

  const updated = patch(base);

  return {
    ...state,
    toolCalls:
      existing === undefined
        ? [...state.toolCalls, updated]
        : state.toolCalls.map((call) => (call.callId === callId ? updated : call)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sélecteurs
// ─────────────────────────────────────────────────────────────────────────────

/** Tâches en cours ou en attente — ce que l'utilisateur regarde en premier. */
export function activeTasks(state: ClientState): TaskView[] {
  return state.tasks.filter(
    (task) =>
      task.status === "running" ||
      task.status === "pending" ||
      task.status === "waiting_for_confirmation",
  );
}

export function finishedTasks(state: ClientState): TaskView[] {
  return state.tasks.filter(
    (task) =>
      task.status === "succeeded" ||
      task.status === "partial" ||
      task.status === "failed" ||
      task.status === "cancelled",
  );
}

export function pendingConfirmations(state: ClientState): ConfirmationView[] {
  return state.confirmations.filter((confirmation) => !confirmation.answered);
}

export function unreadNotifications(state: ClientState): NotificationView[] {
  return state.notifications.filter((notification) => notification.readAt === null);
}

/** L'application peut-elle agir ? Réseau **et** connexion au cœur. */
export function canInteract(state: ClientState): boolean {
  return state.online && state.connection === "connected";
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lit une chaine d'une charge utile non typee.
 *
 * `String(valeur)` sur un objet donne `[object Object]` — une chaine qui a l'air
 * valide et qui s'affiche telle quelle dans l'interface. Ces accesseurs refusent
 * silencieusement ce qui n'est pas du bon type et rendent le repli.
 */
function str(payload: Record<string, unknown>, key: string, fallback = ""): string {
  const value = payload[key];
  return typeof value === "string" ? value : fallback;
}

function num(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function strings(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asSeverity(value: unknown): "info" | "warning" | "error" {
  return value === "warning" || value === "error" ? value : "info";
}

/**
 * Horodatage porté par la trame.
 *
 * Celui du serveur, pas celui du téléphone : l'horloge d'un mobile dérive, et
 * deux clients qui affichent des heures différentes pour le même événement
 * donnent l'impression que le système ment.
 */
function nowFrom(payload: Record<string, unknown>): string {
  return str(payload, "at") || str(payload, "ts") || new Date(0).toISOString();
}

/** Le cœur a-t-il renvoyé un statut que cet écran connaît ? */
function isTaskStatus(value: string): value is TaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "waiting_for_confirmation" ||
    value === "succeeded" ||
    value === "partial" ||
    value === "failed" ||
    value === "cancelled"
  );
}

/** Une tâche active peut encore changer ; une tâche terminée, non. */
function isActive(status: TaskStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting_for_confirmation";
}

/**
 * Statut de l'exécutant local, tel que l'interface l'affiche.
 *
 * Un point mérite d'être explicite : **cette information vient du cœur**, pas du
 * démon qui tourne à côté. L'interface ne l'interroge pas, ne lit pas ses
 * journaux, ne compte pas ses processus. Elle lit la liste d'appareils que le
 * backend lui renvoie et y reconnaît sa propre machine.
 *
 * Ce détour n'est pas de la bureaucratie. Si la fenêtre lisait l'état du démon
 * en direct, elle afficherait « en ligne » alors que le cœur, lui, considère la
 * machine injoignable — et l'utilisateur ne comprendrait pas pourquoi ses tâches
 * partent ailleurs. La vérité affichée doit être **celle qui décide**.
 *
 * Corollaire utile : ce module se teste entièrement, sans démon, sans réseau.
 */

export type LocalWorkerState =
  /** Aucun démon installé sur ce poste — le client fonctionne seul. */
  | "absent"
  /** Un démon existe mais le cœur ne connaît pas encore cet appareil. */
  | "unpaired"
  /** Appairé, en attente d'approbation humaine. */
  | "pending"
  | "offline"
  | "degraded"
  | "online"
  | "revoked";

/**
 * Un appareil vu par le cœur.
 *
 * Structurel : `DeviceView` (canal temps réel) comme `ApiDevice` (REST) le
 * satisfont. Écrire l'union des deux ici les ferait diverger au premier champ
 * ajouté d'un côté seulement.
 */
export interface ObservedDevice {
  id: string;
  name: string;
  role: string;
  status: string;
  capabilities: readonly string[];
  trust?: string;
  health?: {
    activeTasks: number;
    maxConcurrentTasks: number;
    batteryPercent?: number;
    onBattery?: boolean;
  };
}

export interface LocalWorkerStatus {
  state: LocalWorkerState;
  deviceId: string | null;
  name: string | null;
  capabilities: readonly string[];
  activeTasks: number;
  maxConcurrentTasks: number;
  /** Vrai quand l'appareil peut réellement recevoir une étape maintenant. */
  acceptingTasks: boolean;
  /** Phrase affichable telle quelle, sans reformulation dans le composant. */
  summary: string;
}

export interface LocalWorkerInput {
  /** Identifiant lu dans l'état du démon local. `null` = pas de démon. */
  localWorkerDeviceId: string | null;
  /** Appareils tels que le cœur les décrit. */
  devices: readonly ObservedDevice[];
}

const ABSENT: LocalWorkerStatus = {
  state: "absent",
  deviceId: null,
  name: null,
  capabilities: [],
  activeTasks: 0,
  maxConcurrentTasks: 0,
  acceptingTasks: false,
  summary: "Aucun exécutant NEXUS installé sur ce poste.",
};

export function localWorkerStatus(input: LocalWorkerInput): LocalWorkerStatus {
  if (input.localWorkerDeviceId === null) return ABSENT;

  const device = input.devices.find((candidate) => candidate.id === input.localWorkerDeviceId);

  if (device === undefined) {
    return {
      ...ABSENT,
      state: "unpaired",
      deviceId: input.localWorkerDeviceId,
      summary:
        "Un exécutant est installé sur ce poste mais le cœur ne le connaît pas encore. " +
        "Lancez l'appairage depuis le démon.",
    };
  }

  const health = device.health ?? { activeTasks: 0, maxConcurrentTasks: 1 };
  const state = stateOf(device);

  return {
    state,
    deviceId: device.id,
    name: device.name,
    capabilities: device.capabilities,
    activeTasks: health.activeTasks,
    maxConcurrentTasks: health.maxConcurrentTasks,
    // Deux conditions, et la seconde est celle qu'on oublie : un exécutant en
    // ligne mais saturé n'accepte rien de plus, et le cœur le sait avant nous.
    acceptingTasks: state === "online" && health.activeTasks < health.maxConcurrentTasks,
    summary: summaryOf(state, device, health),
  };
}

function stateOf(device: ObservedDevice): LocalWorkerState {
  if (device.status === "REVOKED" || device.trust === "REVOKED") return "revoked";
  if (device.trust === "PENDING") return "pending";
  if (device.status === "DEGRADED") return "degraded";
  if (device.status === "ONLINE") return "online";
  return "offline";
}

function summaryOf(
  state: LocalWorkerState,
  device: ObservedDevice,
  health: { activeTasks: number; maxConcurrentTasks: number },
): string {
  const load = `${String(health.activeTasks)}/${String(health.maxConcurrentTasks)} tâche(s)`;

  switch (state) {
    case "revoked":
      return "Exécutant révoqué. Il n'exécutera plus rien tant qu'il n'est pas réappairé.";
    case "pending":
      return "Exécutant en attente d'approbation. Approuvez-le pour qu'il reçoive des tâches.";
    case "degraded":
      return `Exécutant dégradé — ${load}. Le cœur préférera une autre machine.`;
    case "online":
      return health.activeTasks >= health.maxConcurrentTasks
        ? `Exécutant saturé — ${load}. Les nouvelles étapes iront ailleurs.`
        : `Exécutant prêt — ${load}, ${String(device.capabilities.length)} capacité(s).`;
    case "offline":
      return "Exécutant hors ligne. Le démon NEXUS ne tourne pas, ou n'atteint pas le cœur.";
    // `absent` et `unpaired` sont traités avant l'appel ; les nommer ici évite
    // qu'un ajout futur à l'union passe en silence.
    case "absent":
    case "unpaired":
      return ABSENT.summary;
  }
}

/**
 * Les autres exécutants de la flotte.
 *
 * Le poste fixe et le Redmi apparaissent ici. L'interface les **montre**, elle
 * ne les pilote pas : il n'existe aucun bouton « exécuter sur cette machine ».
 * On demande une capacité, le cœur choisit — voir `taskRequestBody`.
 */
export function remoteWorkers(input: LocalWorkerInput): ObservedDevice[] {
  return input.devices.filter(
    (device) =>
      device.id !== input.localWorkerDeviceId &&
      (device.role === "WORKER" || device.role === "BOTH"),
  );
}

import { createTaskPlan, type TaskPlan, type TaskStepInput } from "@nexus/devices";
import {
  mountClient,
  mountWorker,
  type CapabilityBehaviour,
  type ClientRig,
  type WorkerRig,
} from "./laptop.js";
import {
  createAccount,
  makeApi,
  registerDevice,
  until,
  type Account,
  type ApiHarness,
  type RegisteredDevice,
} from "./harness.js";

/**
 * La flotte complète, montée pour de vrai.
 *
 * C'est l'architecture finale, telle qu'elle tourne :
 *
 *     iPhone 17        CLIENT           pilote
 *     Portable Windows CLIENT + WORKER  pilote **et** exécute
 *     Poste fixe       WORKER           exécute
 *     Redmi Note 10S   WORKER           exécute
 *     NEXUS Core       autorité centrale
 *
 * Rien de tout cela n'est écrit dans le code du cœur : ce sont quatre lignes de
 * registre. Chercher « Redmi » ou « poste fixe » ailleurs que dans les fixtures
 * de test ne donne rien, et c'est la propriété qu'on vérifie en montant la
 * flotte depuis l'extérieur.
 *
 * ## Ce qui est réel, et ce qui ne l'est pas
 *
 * **Réel** : les deux clients sont `SessionManager` + `RealtimeClient` +
 * réducteur de `@nexus/client-core` — le code que l'iPhone et la fenêtre Windows
 * exécutent. Les trois exécutants sont `WorkerRuntime` de `@nexus/worker-core` —
 * celui du démon. Le cœur est l'API Fastify complète, avec ses vraies
 * signatures Ed25519, sa vraie sélection d'exécutant, son vrai coordinateur, ses
 * vraies confirmations.
 *
 * **Doublé** : le transport réseau (branchement direct sur les canaux, mêmes
 * enveloppes, mêmes schémas) et les appels système des exécutants — on ne lance
 * pas Chrome sur la machine qui exécute la suite de tests.
 *
 * **Absent** : il n'y a **pas de modèle de langage**. La traduction d'une phrase
 * française en plan de tâche appartient au service agent, qui n'est pas encore
 * câblé. Les scénarios partent donc du plan que la phrase dénote, et éprouvent
 * tout ce qui suit. C'est une limite réelle, et elle est dite plutôt que
 * masquée par un planificateur de circonstance.
 */

export interface Fleet {
  harness: ApiHarness;
  account: Account;

  devices: {
    iphone: RegisteredDevice;
    laptop: RegisteredDevice;
    desktop: RegisteredDevice;
    redmi: RegisteredDevice;
  };

  /** Les deux clients. Le portable est les deux à la fois. */
  iphone: ClientRig;
  laptop: ClientRig;

  /** Les trois exécutants. */
  laptopWorker: WorkerRig;
  desktop: WorkerRig;
  redmi: WorkerRig;

  close(): Promise<void>;
}

/**
 * Capacités de chaque machine.
 *
 * Elles décrivent ce que la machine **sait faire**. Ce qu'elle a le **droit** de
 * faire est une autre question, tranchée par les permissions de l'utilisateur —
 * et les deux ne sont jamais confondues.
 */
export const LAPTOP_CAPABILITIES = [
  "terminal.execute",
  "filesystem.read",
  "filesystem.write",
  "git.status",
];

export const DESKTOP_CAPABILITIES = [
  "browser.open",
  "terminal.execute",
  "filesystem.read",
  "filesystem.write",
  "process.start",
  "process.list",
  "git.clone",
];

export const REDMI_CAPABILITIES = ["android.app.open", "android.app.list", "android.notification"];

/** Tout ce que l'utilisateur a autorisé, toutes machines confondues. */
export const GRANTED = [
  ...new Set([...LAPTOP_CAPABILITIES, ...DESKTOP_CAPABILITIES, ...REDMI_CAPABILITIES]),
];

export interface FleetOptions {
  /** Comportement des capacités, par appareil. */
  behaviours?: {
    laptop?: Readonly<Record<string, CapabilityBehaviour>>;
    desktop?: Readonly<Record<string, CapabilityBehaviour>>;
    redmi?: Readonly<Record<string, CapabilityBehaviour>>;
  };
  /** Risque à partir duquel une confirmation humaine est exigée. */
  confirmationThreshold?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export async function bootFleet(options: FleetOptions = {}): Promise<Fleet> {
  const harness = await makeApi(
    options.confirmationThreshold === undefined
      ? undefined
      : { confirmationThreshold: options.confirmationThreshold },
  );
  const account = await createAccount(harness);

  const iphoneDevice = await registerDevice(harness, account, {
    name: "iPhone 17",
    role: "CLIENT",
    type: "IPHONE",
    platform: "IOS",
    permissions: GRANTED,
  });

  // Le portable : **un seul appareil**, rôle `BOTH`. Deux lignes de registre
  // pour la même machine donneraient deux entrées dans la flotte et deux états
  // de santé contradictoires.
  const laptopDevice = await registerDevice(harness, account, {
    name: "Portable Windows",
    role: "BOTH",
    permissions: GRANTED,
  });

  const desktopDevice = await registerDevice(harness, account, {
    name: "Poste fixe Windows",
    role: "WORKER",
    permissions: GRANTED,
  });

  const redmiDevice = await registerDevice(harness, account, {
    name: "Redmi Note 10S",
    role: "WORKER",
    type: "ANDROID",
    platform: "ANDROID",
    permissions: GRANTED,
  });

  const iphone = await mountClient(harness, account, iphoneDevice);
  const laptop = await mountClient(harness, account, laptopDevice);

  const laptopWorker = mountWorker(harness, laptopDevice, {
    capabilities: LAPTOP_CAPABILITIES,
    connectionId: "conn-laptop",
    ...(options.behaviours?.laptop === undefined ? {} : { behaviours: options.behaviours.laptop }),
  });
  const desktop = mountWorker(harness, desktopDevice, {
    capabilities: DESKTOP_CAPABILITIES,
    connectionId: "conn-desktop",
    ...(options.behaviours?.desktop === undefined
      ? {}
      : { behaviours: options.behaviours.desktop }),
  });
  const redmi = mountWorker(harness, redmiDevice, {
    capabilities: REDMI_CAPABILITIES,
    connectionId: "conn-redmi",
    platform: "ANDROID",
    ...(options.behaviours?.redmi === undefined ? {} : { behaviours: options.behaviours.redmi }),
  });

  await Promise.all([laptopWorker.runtime.start(), desktop.runtime.start(), redmi.runtime.start()]);

  // On attend que les capacités soient **enregistrées**, pas seulement que la
  // session soit ouverte : le sélecteur choisit sur les capacités, et partir
  // trop tôt rendrait les scénarios intermittents.
  await until(async () => {
    const devices = await harness.services.deviceRegistry.listDevices(account.userId);
    return devices
      .filter((device) => device.role !== "CLIENT")
      .every((device) => device.capabilities.length > 0);
  });

  return {
    harness,
    account,
    devices: {
      iphone: iphoneDevice,
      laptop: laptopDevice,
      desktop: desktopDevice,
      redmi: redmiDevice,
    },
    iphone,
    laptop,
    laptopWorker,
    desktop,
    redmi,
    close: () => harness.close(),
  };
}

/**
 * Le plan qu'une demande dénote.
 *
 * Le service agent le produira à partir d'une phrase ; en son absence, les
 * scénarios l'écrivent à la main. Le nom de la machine, quand l'utilisateur en
 * cite une, devient un `preferredDeviceId` — une **préférence**, pondérée par le
 * sélecteur, jamais un contournement : un appareil préféré qui n'a pas la
 * capacité reste écarté.
 */
export function planFor(input: {
  userId: string;
  title: string;
  originClientDeviceId: string;
  steps: TaskStepInput[];
  correlationId?: string;
}): TaskPlan {
  return createTaskPlan({
    userId: input.userId,
    title: input.title,
    originClientDeviceId: input.originClientDeviceId,
    correlationId: input.correlationId ?? `corr-${input.title.slice(0, 12)}`,
    steps: input.steps,
  });
}

/**
 * Attend qu'une condition devienne vraie, **en laissant tourner l'horloge**.
 *
 * `until` du harnais ne fait tourner que la file de micro-tâches : c'est ce
 * qu'il faut pour éprouver une machine à états sans attendre réellement. Un
 * scénario de bout en bout, lui, traverse des minuteries — délais de dispatch,
 * expiration de confirmation, reprise après coupure — et une boucle de
 * micro-tâches ne les atteint jamais.
 *
 * D'où deux fonctions distinctes plutôt qu'une qui ferait mal les deux.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  // Généreux par défaut. Cette échéance est un **filet**, pas une mesure de
  // performance : sous la suite complète, quatorze paquets se disputent la
  // machine, et un délai serré ferait échouer un scénario qui a simplement pris
  // son temps. Une attente réellement infinie, elle, masquerait un blocage.
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`condition jamais atteinte : ${options.label ?? "(sans nom)"}`);
}

/** Lance un plan par le superviseur, comme le fait la route `POST /tasks`. */
export function runPlan(fleet: Fleet, plan: TaskPlan): void {
  fleet.harness.services.supervisor.start(plan, GRANTED);
}

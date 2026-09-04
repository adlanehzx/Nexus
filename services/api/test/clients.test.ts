import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, reduce, resyncTasks, type ClientState } from "@nexus/client-core";
import type { LLMProvider } from "@nexus/llm";
import { mountClient, mountWorker, type ClientRig, type WorkerRig } from "./laptop.js";
import {
  createAccount,
  makeApi,
  registerDevice,
  settle,
  until,
  type Account,
  type ApiHarness,
  type RegisteredDevice,
} from "./harness.js";

/**
 * Les vrais clients pilotent le cœur.
 *
 * C'est le contrat de la phase 6, et il se vérifie d'un bout à l'autre :
 * l'utilisateur tape une phrase sur son iPhone, et une machine bouge.
 *
 *     client → cœur → planificateur → autorisation → superviseur
 *            → passerelle → exécutant → résultat → cœur → client
 *
 * **Ce qui est réel ici** : le `SessionManager` et l'`ApiClient` de
 * `@nexus/client-core` — le code que l'iPhone exécute —, le `RealtimeClient`, le
 * réducteur d'écran, l'API Fastify complète, le planificateur, les
 * autorisations, le superviseur, la passerelle et un `WorkerRuntime`.
 *
 * **Ce qui est doublé** : le transport réseau (branchement direct sur les
 * canaux, mêmes enveloppes) et le modèle de langage — un planificateur qui
 * appellerait Anthropic rendrait ces tests non déterministes et payants. Le
 * double rend un plan fixe ; tout ce qui suit est le vrai chemin.
 */

/**
 * Modèle simulé.
 *
 * Il rend toujours le même plan : ouvrir Chrome sur un poste. Ce qui est
 * éprouvé n'est pas la qualité de la planification — c'est que le client la
 * déclenche, que le cœur l'autorise, et qu'un exécutant l'exécute.
 */
function fakePlanner(step: { capability: string; tool: string; riskLevel: string }) {
  return {
    id: "fake",
    model: "fake",
    capabilities: {
      tools: false,
      vision: false,
      structuredOutput: true,
      maxContextTokens: 100_000,
    },
    countTokens: () => Promise.resolve(10),
    structuredOutput: <T>(): Promise<T> =>
      Promise.resolve({
        title: "Ouvrir Chrome",
        reasoning: "Demande de l'utilisateur",
        steps: [
          {
            id: "step-1",
            description: "Ouvre Chrome",
            requiredCapabilities: [step.capability],
            tool: step.tool,
            arguments: { app: "chrome" },
            dependsOn: [],
            riskLevel: step.riskLevel,
          },
        ],
      } as unknown as T),
    generate: () =>
      Promise.resolve({
        content: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "fake",
      }),
    // eslint-disable-next-line @typescript-eslint/require-await
    stream: async function* () {
      yield { type: "text_delta", delta: "" } as never;
    },
  } as unknown as LLMProvider;
}

interface Rig {
  harness: ApiHarness;
  account: Account;
  iphone: RegisteredDevice;
  desktop: RegisteredDevice;
  client: ClientRig;
  api: ApiClient;
  worker: WorkerRig;
}

const GRANTED = ["app.open", "terminal.execute"];

async function boot(
  options: {
    capability?: string;
    riskLevel?: string;
    confirmationThreshold?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    permissions?: string[];
  } = {},
): Promise<Rig> {
  const capability = options.capability ?? "app.open";

  const harness = await makeApi({
    llmProvider: fakePlanner({
      capability,
      tool: `device.${capability}`,
      riskLevel: options.riskLevel ?? "LOW",
    }),
    ...(options.confirmationThreshold === undefined
      ? {}
      : { confirmationThreshold: options.confirmationThreshold }),
  });

  const account = await createAccount(harness);
  const permissions = options.permissions ?? GRANTED;

  const iphone = await registerDevice(harness, account, {
    name: "iPhone 17",
    role: "CLIENT",
    type: "IPHONE",
    platform: "IOS",
    permissions,
  });
  const desktop = await registerDevice(harness, account, {
    name: "Poste fixe",
    role: "WORKER",
    permissions,
  });

  const client = await mountClient(harness, account, iphone);
  const api = new ApiClient(client.session);

  const worker = mountWorker(harness, desktop, {
    capabilities: [capability],
    connectionId: "conn-desktop",
  });
  await worker.runtime.start();

  await until(async () => {
    const device = await harness.services.deviceRegistry.requireDevice(desktop.device.id);
    return device.capabilities.length > 0;
  });

  return { harness, account, iphone, desktop, client, api, worker };
}

let rig: Rig | undefined;

beforeEach(() => {
  rig = undefined;
});

afterEach(async () => {
  await rig?.harness.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Le chemin complet
// ─────────────────────────────────────────────────────────────────────────────

describe("l'instruction d'un client pilote la flotte", () => {
  it("« ouvre Chrome sur mon PC » atteint réellement l'exécutant", async () => {
    // Le test qui donne son sens à la phase. Avant, l'iPhone archivait la
    // phrase dans la conversation et rien ne se passait.
    rig = await boot();

    const plan = await rig.api.instruct({
      instruction: "ouvre Chrome sur mon PC",
      originClientDeviceId: rig.iphone.device.id,
    });

    expect(plan.id).toBeTruthy();
    expect(plan.originClientDeviceId).toBe(rig.iphone.device.id);

    await until(() => rig!.worker.executed.length > 0);

    expect(rig.worker.executed[0]?.capability).toBe("app.open");
    expect(rig.worker.executed[0]?.input).toMatchObject({ app: "chrome" });
  });

  it("le client reçoit l'état de la tâche jusqu'à son terme", async () => {
    rig = await boot();

    await rig.api.instruct({
      instruction: "ouvre Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });

    await until(() => rig!.client.state().tasks.some((task) => task.status === "succeeded"));

    const task = rig.client.state().tasks[0];
    expect(task?.status).toBe("succeeded");
    expect(task?.percent).toBe(100);
    // Le fil de routage tient : l'écran sait d'où la demande est partie.
    expect(task?.originClientDeviceId).toBe(rig.iphone.device.id);
  });

  it("le client ne planifie ni n'exécute : il transmet une phrase", async () => {
    // Le corps envoyé ne nomme ni exécutant, ni capacité, ni outil. Si un
    // client composait le plan, il court-circuiterait le planificateur et
    // deviendrait un second cœur.
    rig = await boot();

    const plan = await rig.api.instruct({
      instruction: "ouvre Chrome sur mon PC",
      originClientDeviceId: rig.iphone.device.id,
    });

    // Le plan revient **déjà construit par le cœur** : le client n'a fourni
    // qu'une phrase et son identité d'appareil. Il découvre les étapes, il ne
    // les a pas écrites.
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0]?.description).toBeTruthy();
    // Et il n'a jamais nommé d'exécutant : c'est le sélecteur qui a choisi.
    expect(plan.steps[0]?.selectedDeviceId ?? rig.desktop.device.id).toBe(rig.desktop.device.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Autorisation : un client ne contourne rien
// ─────────────────────────────────────────────────────────────────────────────

describe("aucun contournement depuis un client", () => {
  it("une instruction dont la capacité n'est pas accordée est refusée", async () => {
    // La permission manque : le cœur refuse **avant** de dispatcher. C'est le
    // planificateur qui a choisi la capacité, pas le client — et cela ne le
    // dispense d'aucun contrôle.
    rig = await boot({ capability: "terminal.execute", permissions: ["app.open"] });

    await expect(
      rig.api.instruct({
        instruction: "lance une commande",
        originClientDeviceId: rig.iphone.device.id,
      }),
    ).rejects.toThrow();

    await settle(20);
    expect(rig.worker.executed).toEqual([]);
  });

  it("un client ne peut pas se faire passer pour un appareil qui n'est pas le sien", async () => {
    rig = await boot();

    await expect(
      rig.api.instruct({
        instruction: "ouvre Chrome",
        originClientDeviceId: "device-inconnu",
      }),
    ).rejects.toThrow();
  });

  it("une action risquée attend une confirmation humaine avant d'atteindre l'exécutant", async () => {
    // Le client affiche la demande ; il ne la tranche pas tout seul. Tant que
    // personne n'a répondu, rien ne bouge sur la machine.
    rig = await boot({ riskLevel: "CRITICAL", confirmationThreshold: "MEDIUM" });

    await rig.api.instruct({
      instruction: "supprime tout",
      originClientDeviceId: rig.iphone.device.id,
    });

    await until(() => rig!.client.state().confirmations.length > 0);

    const confirmation = rig.client.state().confirmations[0];
    expect(confirmation?.riskLevel).toBe("CRITICAL");
    expect(confirmation?.answered).toBe(false);

    // Rien n'a été exécuté pendant l'attente.
    await settle(20);
    expect(rig.worker.executed).toEqual([]);
  });

  it("le refus d'une confirmation empêche l'exécution", async () => {
    rig = await boot({ riskLevel: "CRITICAL", confirmationThreshold: "MEDIUM" });

    await rig.api.instruct({
      instruction: "supprime tout",
      originClientDeviceId: rig.iphone.device.id,
    });
    await until(() => rig!.client.state().confirmations.length > 0);

    const id = rig.client.state().confirmations[0]!.id;
    await rig.client.realtime.respondToConfirmation(id, "rejected");

    await settle(30);
    expect(rig.worker.executed).toEqual([]);
  });

  it("une confirmation approuvée laisse l'exécution reprendre", async () => {
    rig = await boot({ riskLevel: "CRITICAL", confirmationThreshold: "MEDIUM" });

    await rig.api.instruct({
      instruction: "ouvre Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });
    await until(() => rig!.client.state().confirmations.length > 0);

    const id = rig.client.state().confirmations[0]!.id;
    await rig.client.realtime.respondToConfirmation(id, "approved");

    await until(() => rig!.worker.executed.length > 0);
    expect(rig.worker.executed[0]?.capability).toBe("app.open");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotence : une coupure ne double jamais une action
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotence vue du client", () => {
  it("une reconnexion ne relance aucune instruction", async () => {
    // Le danger de la phase : « achète X », coupure, reconnexion, seconde
    // commande. La reconnexion ne rejoue rien — elle relit.
    rig = await boot();

    await rig.api.instruct({
      instruction: "ouvre Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });
    await until(() => rig!.worker.executed.length > 0);

    const before = rig.worker.executed.length;

    rig.client.socket.close("coupure réseau");
    await settle(20);
    await rig.client.realtime.start();
    await settle(30);

    expect(rig.worker.executed).toHaveLength(before);
    expect(rig.client.state().tasks).toHaveLength(1);
  });

  it("deux instructions identiques créent deux tâches distinctes, et c'est voulu", async () => {
    // On ne déduplique pas sur le texte : « éteins la lumière » deux fois de
    // suite est une demande légitime. La protection porte sur les réessais
    // réseau, pas sur l'intention de l'utilisateur — et le client ne réessaie
    // jamais tout seul.
    rig = await boot();

    const first = await rig.api.instruct({
      instruction: "ouvre Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });
    const second = await rig.api.instruct({
      instruction: "ouvre Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });

    expect(first.id).not.toBe(second.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reprise d'état après coupure
// ─────────────────────────────────────────────────────────────────────────────

describe("rattrapage après coupure", () => {
  it("le client récupère auprès du cœur l'état d'une tâche achevée hors ligne", async () => {
    // Sans ce rattrapage, l'écran garderait « en cours » indéfiniment : le
    // canal ne rejoue pas les trames émises pendant la coupure.
    rig = await boot();

    const plan = await rig.api.instruct({
      instruction: "ouvre Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });

    // Le client se coupe avant la fin.
    rig.client.socket.close("tunnel");
    await until(() => rig!.worker.executed.length > 0);
    await settle(30);

    // Le cœur, lui, a terminé.
    const fromCore = await rig.api.getTask(plan.id);
    expect(fromCore.status).toBe("succeeded");

    // Et le rattrapage aligne l'écran. On part de ce que le client afficherait
    // après la coupure : « en cours », figé.
    let state: ClientState = {
      ...rig.client.state(),
      tasks: [
        {
          id: plan.id,
          title: plan.title,
          status: "running",
          percent: 40,
          label: "en cours",
          workerDeviceId: null,
          originClientDeviceId: rig.iphone.device.id,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          error: null,
          stepCount: 1,
        },
      ],
    };

    const outcome = await resyncTasks({
      api: rig.api,
      state,
      dispatch: (action) => {
        state = reduce(state, action);
      },
    });

    expect(outcome.checked).toBe(1);
    expect(outcome.updated).toBe(1);
    expect(state.tasks[0]?.status).toBe("succeeded");
    expect(state.tasks[0]?.percent).toBe(100);
    // Une seule tâche : le rattrapage lit, il ne crée pas.
    expect(state.tasks).toHaveLength(1);
  });
});

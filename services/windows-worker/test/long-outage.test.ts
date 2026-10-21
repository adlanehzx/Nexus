import { describe, expect, it } from "vitest";
import { WORKER_MESSAGE } from "@nexus/protocol";
import { createTaskPlan } from "@nexus/devices";
import { makeHarness, until, ALLOWED_ROOT, IPHONE, USER_ID } from "./fixtures.js";

/**
 * Coupures longues.
 *
 * Une coupure de trois secondes ne prouve rien : tout survit à trois secondes.
 * Ce qui casse un worker, c'est l'absence **prolongée** — le portable fermé une
 * nuit, le Wi-Fi coupé pendant une réunion, le cœur redémarré pour une
 * migration. Pendant ce temps, le temps passe *côté cœur* : les sessions
 * expirent, l'appareil bascule hors ligne, les nonces vieillissent. Le worker,
 * lui, ne fait qu'attendre.
 *
 * C'est ce décalage qui est éprouvé ici, et c'est pourquoi le harnais a deux
 * horloges : celle du cœur, qu'on avance, et les minuteries du worker, qu'on
 * déclenche.
 */

const PERMISSIONS = ["terminal.execute", "filesystem.read"];

/** Sélectionne les messages d'un type dans ce que le worker a émis. */
const sent = (harness: Awaited<ReturnType<typeof makeHarness>>, type: string) =>
  harness.link.sent.filter((envelope) => envelope.type === type);

/**
 * Une coupure « longue ».
 *
 * Longue **relativement à la durée de vie d'une session**, qui est ce qui
 * compte : les tests règlent cette durée à 40 ms et attendent 80 ms, donc la
 * session expire pour de vrai, dans le vrai temps.
 *
 * La tentation était d'avancer une horloge de dix heures. Elle ne fonctionne
 * pas, et la raison est instructive : le worker signe ses trames avec sa propre
 * horloge, et la passerelle refuse une poignée de main dont l'horodatage dérive
 * trop. Déplacer l'horloge du cœur faisait donc échouer la reprise pour dérive
 * d'horloge — un refus correct, mais qui n'est pas le sujet.
 */
const SESSION_TTL_MS = 40;
const outage = () => new Promise((resolve) => setTimeout(resolve, SESSION_TTL_MS * 2));

describe("reprise après une coupure longue", () => {
  it("se reconnecte avec une poignée de main complète, pas une session périmée", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
    });
    await harness.connectWorker();
    expect(harness.worker.state).toBe("ready");

    const firstHandshakes = sent(harness, WORKER_MESSAGE.authenticate).length;
    expect(firstHandshakes).toBe(1);

    // ── La coupure : une nuit entière.
    await harness.dropLink();
    await outage();

    // Le worker reconnecte quand sa minuterie arrive à terme. On attend que la
    // poignée de main soit **repartie**, et non un état : « reconnecting » est
    // vrai dès la première milliseconde, donc l'attendre n'attend rien.
    harness.timers.flush();
    await until(() => sent(harness, WORKER_MESSAGE.authenticate).length > firstHandshakes);
    await until(() => harness.worker.state === "ready");

    // Le point : il a **re-signé un challenge**. Réutiliser le jeton de session
    // d'hier serait inutile — il est expiré côté cœur — et le worker ne doit pas
    // découvrir ça au premier dispatch, c'est-à-dire au pire moment.
    expect(sent(harness, WORKER_MESSAGE.authenticate).length).toBe(firstHandshakes + 1);
    expect(harness.worker.state).toBe("ready");
  });

  it("retrouve l'appareil en ligne et capable de travailler", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
    });
    await harness.connectWorker();

    await harness.dropLink();
    // Le cœur doit voir l'appareil hors ligne : un appareil qu'il croit en
    // ligne se verrait confier des tâches qui n'arriveraient jamais.
    await until(
      async () => (await harness.registry.requireDevice(harness.device.id)).status !== "ONLINE",
    );

    await outage();
    harness.timers.flush();
    await until(() => harness.worker.state === "ready");
    // L'enregistrement qui suit la poignée de main est ce qui remet l'appareil
    // en ligne : l'attendre évite d'observer un état intermédiaire.
    await until(() => sent(harness, WORKER_MESSAGE.register).length >= 2);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.status).toBe("ONLINE");
    expect(device.trust).toBe("TRUSTED");
    // La confiance n'a pas à être redonnée : la coupure n'est pas une faute.
    expect(device.revokedAt).toBeNull();
  });

  it("exécute un plan après la reprise, comme si rien ne s'était passé", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\note.txt`, "après la nuit");
      },
    });
    await harness.connectWorker();
    await harness.attachClient();

    await harness.dropLink();
    await outage();
    harness.timers.flush();
    await until(() => harness.worker.state === "ready");
    await until(() => sent(harness, WORKER_MESSAGE.register).length >= 2);

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Relire la note",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-apres-coupure",
      steps: [
        {
          id: "lire",
          description: "Lire le fichier",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\note.txt` },
          riskLevel: "SAFE",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });
    expect(executed.status).toBe("succeeded");
    expect(executed.steps[0]?.selectedDeviceId).toBe(harness.device.id);
    expect((executed.steps[0]?.result as { content: string }).content).toBe("après la nuit");
  });

  it("n'inonde pas le cœur : l'attente croît et plafonne", async () => {
    const harness = await makeHarness({
      config: { reconnectMinMs: 1_000, reconnectMaxMs: 60_000 },
      rotateConnections: true,
    });
    await harness.connectWorker();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await harness.dropLink();
      // Le prochain `connect` échoue : on simule une coupure qui dure, et non
      // une série de coupures brèves.
      harness.link.failNextConnect = true;
      const scheduled = harness.timers.delays.at(-1);
      if (scheduled !== undefined) delays.push(scheduled);
      harness.timers.flush();
      await until(() => harness.worker.state !== "connecting");
    }

    expect(delays.length).toBeGreaterThan(3);
    // Sans croissance, un cœur qui redémarre se fait retomber par ses propres
    // workers ; sans plafond, un worker oublié attendrait des heures.
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
    expect(Math.max(...delays)).toBeGreaterThan(Math.min(...delays));
  });

  it("le nonce d'avant la coupure ne sert plus après", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
    });
    await harness.connectWorker();

    const first = sent(harness, WORKER_MESSAGE.authenticate)[0];
    const firstNonce = (first?.payload as { nonce?: string } | undefined)?.nonce;
    expect(firstNonce).toBeTruthy();

    await harness.dropLink();
    await outage();
    harness.timers.flush();
    await until(() => harness.worker.state === "ready");

    const second = sent(harness, WORKER_MESSAGE.authenticate).at(-1);
    const secondNonce = (second?.payload as { nonce?: string } | undefined)?.nonce;
    // Un nonce rejouable transformerait une trame capturée pendant la coupure
    // en session valide après elle.
    expect(secondNonce).toBeTruthy();
    expect(secondNonce).not.toBe(firstNonce);
  });

  it("une tâche confiée pendant la coupure échoue franchement, au lieu de disparaître", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
    });
    await harness.connectWorker();
    await harness.attachClient();

    await harness.dropLink();
    await until(
      async () => (await harness.registry.requireDevice(harness.device.id)).status !== "ONLINE",
    );

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Pendant la coupure",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-pendant-coupure",
      steps: [
        {
          id: "lire",
          description: "Lire le fichier",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\absent.txt` },
          riskLevel: "SAFE",
        },
      ],
    });

    // Le cœur n'a aucun exécutant éligible. Il doit le **dire** : un plan qui
    // resterait « en cours » indéfiniment est la pire des réponses, parce que
    // personne ne sait s'il faut attendre ou réessayer.
    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });
    expect(executed.status).toBe("failed");
    expect(JSON.stringify(executed.steps[0]?.error)).toMatch(/éligible|ligne|worker/i);
  });
});

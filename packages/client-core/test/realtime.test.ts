import { describe, expect, it } from "vitest";
import { SERVER_TO_CLIENT } from "@nexus/protocol";
import { RealtimeClient } from "../src/realtime.js";
import { SessionManager } from "../src/session.js";
import { initialState, reduce, type ClientAction, type ClientState } from "../src/store.js";
import {
  FakeHttpClient,
  FakeNetwork,
  FakeSecureStorage,
  FakeSocket,
  TestTimers,
  loginResponse,
  settle,
  until,
} from "./fixtures.js";

/**
 * Le canal temps réel, côté téléphone.
 *
 * Un mobile perd le réseau en permanence. La reconnexion n'est donc pas un cas
 * d'erreur mais le régime normal, et c'est ce que ce fichier éprouve : couper,
 * revenir, couper encore, sans jamais laisser une promesse ouverte ni composer
 * dans le vide.
 */

interface Harness {
  client: RealtimeClient;
  socket: FakeSocket;
  network: FakeNetwork;
  timers: TestTimers;
  http: FakeHttpClient;
  session: SessionManager;
  state(): ClientState;
  actions: ClientAction[];
}

async function makeClient(): Promise<Harness> {
  const http = new FakeHttpClient();
  http.on("POST", "/api/v1/auth/login", loginResponse());
  http.on("POST", "/api/v1/auth/refresh", {
    status: 200,
    body: {
      data: { accessToken: "jeton-acces-2", refreshToken: "jeton-rafraichissement-2" },
    },
  });

  const session = new SessionManager({ http, storage: new FakeSecureStorage() });
  await session.login("adlan@exemple.fr", "un mot de passe suffisant");

  const socket = new FakeSocket();
  const network = new FakeNetwork();
  const timers = new TestTimers();

  let state = initialState;
  const actions: ClientAction[] = [];

  const client = new RealtimeClient({
    socket,
    session,
    url: "wss://nexus.test/ws/client",
    network,
    timers,
    random: () => 0.5,
    now: () => new Date("2026-09-02T12:00:00.000Z"),
    dispatch: (action) => {
      actions.push(action);
      state = reduce(state, action);
    },
  });

  return { client, socket, network, timers, http, session, actions, state: () => state };
}

describe("connexion", () => {
  it("se connecte et annonce la session", async () => {
    const h = await makeClient();
    await h.client.start();

    expect(h.client.state).toBe("connected");
    // La poignée de main porte le jeton, jamais le mot de passe.
    const hello = h.socket.lastOfType("client.hello");
    expect(hello?.payload.accessToken).toBe("jeton-acces-1");
  });

  it("passe par connecting puis authenticating", async () => {
    const h = await makeClient();
    await h.client.start();

    const states = h.actions
      .filter((action) => action.kind === "connection")
      .map((action) => action.state);

    expect(states).toEqual(["connecting", "authenticating", "connected"]);
  });

  it("programme une reconnexion si le serveur est injoignable", async () => {
    const h = await makeClient();
    h.socket.failNextConnect = true;

    await h.client.start();

    expect(h.client.state).toBe("reconnecting");
    expect(h.timers.pending.size).toBe(1);
  });

  it("ne compose pas dans le vide quand le réseau est absent", async () => {
    // Réessayer sans réseau vide la batterie et n'aboutit jamais.
    const h = await makeClient();
    h.network.set(false);

    await h.client.start();

    expect(h.client.state).toBe("offline");
    expect(h.socket.state).toBe("idle");
  });
});

describe("reconnexion", () => {
  it("reprogramme après une coupure", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.drop("réseau mobile perdu");
    await settle();

    expect(h.client.state).toBe("reconnecting");
    expect(h.timers.delays.some((delay) => delay >= 1_000)).toBe(true);
  });

  it("refait la poignée de main complète", async () => {
    // Une session dont on ne sait pas si elle est encore valide n'est pas une
    // session.
    const h = await makeClient();
    await h.client.start();

    const before = h.socket.sent.filter((m) => m.type === "client.hello").length;

    h.socket.drop();
    await settle();
    h.timers.flush();
    await settle();

    expect(h.socket.sent.filter((m) => m.type === "client.hello").length).toBeGreaterThan(before);
  });

  it("espace les tentatives puis plafonne", async () => {
    const h = await makeClient();
    h.socket.failNextConnect = true;
    await h.client.start();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      delays.push(h.timers.delays[0] ?? 0);
      h.socket.failNextConnect = true;
      h.timers.flush();
      await settle();
    }

    expect(delays[0]).toBeLessThan(delays[3] ?? 0);
    // Le plafond évite qu'une longue coupure ne repousse la reprise à plusieurs
    // minutes alors que l'utilisateur est peut-être revenu.
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
  });

  it("ne programme pas deux reconnexions pour deux coupures rapprochées", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.drop("coupure 1");
    h.socket.drop("coupure 2");
    await settle();

    expect(h.timers.pending.size).toBe(1);
  });

  it("relance immédiatement au retour du réseau", async () => {
    // L'utilisateur vient de sortir du tunnel et regarde son écran : attendre le
    // prochain palier d'attente serait absurde.
    const h = await makeClient();
    await h.client.start();

    h.network.set(false);
    h.socket.drop("réseau perdu");
    await settle();

    const pendingBefore = h.timers.pending.size;
    h.network.set(true);
    await settle();

    expect(h.client.state).toBe("connected");
    expect(pendingBefore).toBeGreaterThan(0);
  });

  it("marque l'état hors ligne dans le magasin", async () => {
    const h = await makeClient();
    await h.client.start();

    h.network.set(false);
    await settle();

    expect(h.state().online).toBe(false);
    expect(h.state().connection).toBe("offline");
  });

  it("un arrêt délibéré ne reconnecte pas", async () => {
    const h = await makeClient();
    await h.client.start();

    h.client.stop("l'utilisateur ferme l'application");
    h.timers.flush();
    await settle();

    expect(h.client.state).toBe("offline");
  });
});

describe("session refusée", () => {
  it("fait tourner le jeton avant de reconnecter", async () => {
    // Le cas d'un poste resté ouvert toute la nuit : la socket tenait, le jeton
    // d'accès a expiré. Reconnecter avec le même jeton échouerait à chaque
    // tentative, indéfiniment et sans rien changer.
    const h = await makeClient();
    await h.client.start();

    h.socket.reject();
    await settle();

    expect(h.http.countOf("POST", "/api/v1/auth/refresh")).toBe(1);
  });

  it("reconnecte avec le jeton neuf", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.reject();
    await settle();

    h.socket.reopen();
    h.timers.flush();
    await settle();

    const hello = h.socket.lastOfType("client.hello");
    expect(hello?.payload.accessToken).toBe("jeton-acces-2");
  });

  it("ne fait pas tourner le jeton sur une simple coupure réseau", async () => {
    // Une rotation à chaque perte de réseau ferait dix rotations par trajet en
    // métro, et le cœur traite un jeton rejoué comme un vol.
    const h = await makeClient();
    await h.client.start();

    h.socket.drop("réseau mobile perdu");
    await settle();

    expect(h.http.countOf("POST", "/api/v1/auth/refresh")).toBe(0);
  });

  it("un rafraîchissement refusé n'empêche pas la reprogrammation", async () => {
    // La session est morte, mais la machine à états ne doit pas se figer :
    // c'est la tentative suivante, sans jeton, qui conclura proprement.
    const h = await makeClient();
    await h.client.start();

    h.http.on("POST", "/api/v1/auth/refresh", { status: 401, body: {} });
    h.socket.reject();
    await settle();

    expect(h.client.state).toBe("reconnecting");
  });
});

describe("demandes et accusés", () => {
  it("corrèle la réponse à la demande", async () => {
    const h = await makeClient();
    await h.client.start();

    const pending = h.client.sendMessage({ conversationId: null, text: "Bonjour" });
    const sent = h.socket.lastOfType("message.send");
    expect(sent?.requestId).toBeTruthy();

    h.socket.deliver(
      SERVER_TO_CLIENT.ack,
      { ok: true, data: { conversationId: "c1", messageId: "m1" }, error: null },
      sent?.requestId,
    );

    await expect(pending).resolves.toEqual({ conversationId: "c1", messageId: "m1" });
  });

  it("distingue plusieurs demandes en vol", async () => {
    const h = await makeClient();
    await h.client.start();

    const first = h.client.cancelTask("t1");
    const second = h.client.cancelTask("t2");

    const requests = h.socket.sent.filter((m) => m.type === "task.cancel");
    expect(requests).toHaveLength(2);

    // Les réponses arrivent dans le désordre : sans `requestId`, elles seraient
    // confondues.
    h.socket.deliver(
      SERVER_TO_CLIENT.ack,
      { ok: true, data: { cancelled: false }, error: null },
      requests[1]?.requestId,
    );
    h.socket.deliver(
      SERVER_TO_CLIENT.ack,
      { ok: true, data: { cancelled: true }, error: null },
      requests[0]?.requestId,
    );

    expect(await first).toEqual({ cancelled: true });
    expect(await second).toEqual({ cancelled: false });
  });

  it("rejette avec le code du serveur", async () => {
    const h = await makeClient();
    await h.client.start();

    const pending = h.client.cancelTask("inconnue");
    const sent = h.socket.lastOfType("task.cancel");

    h.socket.deliver(
      SERVER_TO_CLIENT.ack,
      { ok: false, data: null, error: { code: "NOT_FOUND", message: "Tâche inconnue" } },
      sent?.requestId,
    );

    await expect(pending).rejects.toMatchObject({ message: "Tâche inconnue" });
  });

  it("abandonne une demande restée sans réponse", async () => {
    // Une socket silencieuse laisserait sinon des promesses ouvertes
    // indéfiniment, et l'écran qui les attend figé.
    const h = await makeClient();
    await h.client.start();

    const pending = h.client.cancelTask("t1");
    expect(h.client.pendingRequestCount).toBe(1);

    h.timers.flush();
    await expect(pending).rejects.toThrow(/n'a pas répondu/);
    expect(h.client.pendingRequestCount).toBe(0);
  });

  it("rejette les demandes en vol quand la connexion tombe", async () => {
    const h = await makeClient();
    await h.client.start();

    const pending = h.client.cancelTask("t1");
    h.socket.drop("réseau perdu");

    await expect(pending).rejects.toThrow(/Connexion perdue/);
    expect(h.client.pendingRequestCount).toBe(0);
  });

  it("refuse d'envoyer hors connexion", async () => {
    const h = await makeClient();
    await expect(h.client.cancelTask("t1")).rejects.toThrow(/Pas de connexion/);
  });
});

describe("trames entrantes", () => {
  it("achemine un événement vers le magasin", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.deliver(SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Lancer les tests",
      stepCount: 2,
      originClientDeviceId: "device-iphone",
    });

    await until(() => h.state().tasks.length > 0);
    expect(h.state().tasks[0]).toMatchObject({ id: "t1", title: "Lancer les tests" });
  });

  it("ignore une trame illisible sans fermer la connexion", async () => {
    const h = await makeClient();
    await h.client.start();

    h.socket.deliverRaw("pas du json");
    h.socket.deliverRaw('{"incomplet":true}');
    await settle();

    expect(h.client.state).toBe("connected");
  });

  it("porte l'horodatage du serveur, pas celui du téléphone", async () => {
    // L'horloge d'un mobile dérive ; deux clients qui affichent des heures
    // différentes pour le même événement donnent l'impression que le système ment.
    const h = await makeClient();
    await h.client.start();

    h.socket.deliver(SERVER_TO_CLIENT.notificationCreated, {
      notificationId: "n1",
      title: "Tâche terminée",
      body: "ok",
      severity: "info",
    });

    await until(() => h.state().notifications.length > 0);
    expect(h.state().notifications[0]?.createdAt).toBe("2026-09-02T12:00:00.000Z");
  });
});

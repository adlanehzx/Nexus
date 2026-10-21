import { describe, expect, it } from "vitest";
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
} from "./fixtures.js";

/**
 * Le rattachement d'appareil, du côté du client.
 *
 * C'est la pièce qui manquait après la connexion, et son absence produisait le
 * symptôme le plus déroutant du projet : un iPhone qui se connecte, obtient ses
 * jetons, puis reste indéfiniment « en reconnexion » alors que le réseau va
 * bien, que le jeton est valide et que le cœur répond. La cause tenait en une
 * ligne — la poignée de main du canal client porte un identifiant d'appareil, et
 * il n'y en avait pas.
 *
 * Ce fichier éprouve les deux garanties qui en découlent :
 *
 *  - **l'idempotence** : un compte ne doit pas accumuler un appareil de plus à
 *    chaque installation ;
 *  - **l'ordre** : aucune socket ne s'ouvre avant qu'un appareil ne soit
 *    rattaché, et un échec de rattachement se voit au lieu de se déguiser en
 *    panne réseau.
 *
 * Ce qu'il vérifie aussi, et qui n'est pas accessoire : **rien de tout cela
 * n'accorde le moindre privilège**. Un client s'enregistre ; il ne s'approuve
 * pas, ne se donne pas de permission, et n'obtient pas le droit d'exécuter.
 */

const IPHONE = { name: "iPhone", type: "IPHONE", platform: "IOS", role: "CLIENT" } as const;

/** Un appareil tel que la route `GET /devices` le rend. */
function device(overrides: Record<string, unknown> = {}) {
  return {
    id: "device-iphone",
    name: "iPhone",
    type: "IPHONE",
    platform: "IOS",
    role: "CLIENT",
    status: "OFFLINE",
    trust: "TRUSTED",
    capabilities: [],
    grantedPermissions: [],
    health: { activeTasks: 0, maxConcurrentTasks: 1 },
    lastSeenAt: null,
    authenticated: false,
    ...overrides,
  };
}

function devicesList(...items: unknown[]) {
  return { status: 200, body: { data: items, meta: { total: items.length } } };
}

function makeSession(storage = new FakeSecureStorage()) {
  const http = new FakeHttpClient();
  http.on("POST", "/api/v1/auth/login", loginResponse());
  http.on("POST", "/api/v1/auth/logout", { status: 204, body: null });

  return { http, storage, session: new SessionManager({ http, storage }) };
}

describe("1. connexion avec un appareil déjà rattaché", () => {
  it("n'enregistre rien et ne consulte même pas la flotte", async () => {
    // Le cas de tous les lancements sauf le premier. Il doit rester gratuit :
    // interroger le cœur à chaque ouverture pour réapprendre ce que le trousseau
    // sait déjà ajouterait un aller-retour sur le chemin critique.
    const storage = new FakeSecureStorage();
    storage.values.set("nexus.access", "jeton-acces-1");
    storage.values.set("nexus.refresh", "jeton-rafraichissement-1");
    storage.values.set("nexus.device", "device-deja-la");
    storage.values.set("nexus.user", "u1");

    const { http, session } = makeSession(storage);
    await session.restore();

    const result = await session.ensureDevice(IPHONE);

    expect(result).toEqual({ deviceId: "device-deja-la", origin: "session" });
    expect(http.countOf("POST", "/api/v1/devices")).toBe(0);
    expect(http.countOf("GET", "/api/v1/devices?limit=100")).toBe(0);
  });

  it("reprend l'appareil du compte quand le trousseau a été effacé", async () => {
    // Réinstallation : les jetons sont neufs, l'identifiant d'appareil est
    // perdu, mais la ligne existe toujours côté cœur. Sans ce chemin, chaque
    // réinstallation ajouterait un « iPhone » de plus à approuver.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device()));

    await session.login("alex@example.test", "mot de passe");
    const result = await session.ensureDevice(IPHONE);

    expect(result).toEqual({ deviceId: "device-iphone", origin: "existing", trust: "TRUSTED" });
    expect(http.countOf("POST", "/api/v1/devices")).toBe(0);
    expect(session.deviceId).toBe("device-iphone");
  });

  it("ne reprend jamais un appareil révoqué", async () => {
    // Reprendre une ligne révoquée annulerait la révocation dans les faits.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device({ trust: "REVOKED" })));
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-neuf" } } });

    await session.login("alex@example.test", "mot de passe");
    const result = await session.ensureDevice(IPHONE);

    expect(result.origin).toBe("registered");
    expect(result.deviceId).toBe("device-neuf");
  });

  it("ne reprend pas l'appareil d'un autre téléphone", async () => {
    // Deux iPhone sur le même compte restent deux appareils : les confondre
    // ferait parler l'un au nom de l'autre.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device({ name: "iPhone de Sarah" })));
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-neuf" } } });

    await session.login("alex@example.test", "mot de passe");

    expect((await session.ensureDevice(IPHONE)).origin).toBe("registered");
  });
});

describe("2 et 3. connexion sans appareil : enregistrement", () => {
  it("enregistre l'appareil et retient son identifiant", async () => {
    const { http, storage, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-neuf" } } });

    await session.login("alex@example.test", "mot de passe");
    const result = await session.ensureDevice(IPHONE);

    expect(result).toEqual({ deviceId: "device-neuf", origin: "registered", trust: "PENDING" });
    expect(session.deviceId).toBe("device-neuf");
    // Retenu dans le trousseau : le lancement suivant ne réenregistre rien.
    expect(storage.values.get("nexus.device")).toBe("device-neuf");
  });

  it("n'envoie aucune clé publique pour un CLIENT", async () => {
    // L'iPhone s'authentifie par jeton, et le cœur vérifie déjà que l'appareil
    // appartient au porteur du jeton. Une clé matérielle n'ajouterait rien — et
    // en fabriquer une serait un mécanisme cryptographique de plus à tenir.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");
    await session.ensureDevice(IPHONE);

    const body = http.requests.at(-1)?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("publicKeyPem");
  });

  it("enregistre une seule fois même si le rattachement est redemandé", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");
    await session.ensureDevice(IPHONE);
    await session.ensureDevice(IPHONE);
    await session.ensureDevice(IPHONE);

    expect(http.countOf("POST", "/api/v1/devices")).toBe(1);
  });
});

describe("4. enregistrement refusé", () => {
  it("remonte le message du cœur plutôt qu'une panne générique", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", {
      status: 403,
      body: { error: { code: "DEVICE_QUOTA", message: "Trop d'appareils sur ce compte." } },
    });

    await session.login("alex@example.test", "mot de passe");

    await expect(session.ensureDevice(IPHONE)).rejects.toThrow("Trop d'appareils sur ce compte.");
    // Rien n'est retenu : réessayer doit repartir d'un état propre.
    expect(session.deviceId).toBeNull();
  });

  it("échoue proprement quand le cœur est injoignable", async () => {
    const { http, session } = makeSession();
    await session.login("alex@example.test", "mot de passe");

    http.failNext = true;
    await expect(session.ensureDevice(IPHONE)).rejects.toThrow();
    expect(session.deviceId).toBeNull();
  });

  it("enregistre malgré une liste illisible plutôt que de bloquer", async () => {
    // Mieux vaut un appareil en trop qu'une application qui refuse de démarrer.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", { status: 500, body: null });
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");

    expect((await session.ensureDevice(IPHONE)).origin).toBe("registered");
  });
});

describe("5. appareil en attente d'approbation", () => {
  it("annonce PENDING pour un appareil qui vient d'être créé", async () => {
    // C'est le modèle d'autorisation existant, et il n'est pas contourné : un
    // appareil ne s'auto-approuve pas. L'interface doit pouvoir le dire.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");

    expect((await session.ensureDevice(IPHONE)).trust).toBe("PENDING");
  });

  it("reprend un appareil encore en attente sans le réenregistrer", async () => {
    // L'utilisateur a fermé l'application avant d'approuver. Rouvrir ne doit pas
    // créer un second appareil à approuver.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device({ trust: "PENDING" })));

    await session.login("alex@example.test", "mot de passe");
    const result = await session.ensureDevice(IPHONE);

    expect(result).toEqual({ deviceId: "device-iphone", origin: "existing", trust: "PENDING" });
    expect(http.countOf("POST", "/api/v1/devices")).toBe(0);
  });
});

describe("6. le canal n'ouvre qu'avec un appareil", () => {
  function makeRealtime(session: SessionManager) {
    const socket = new FakeSocket();
    const timers = new TestTimers();
    const actions: ClientAction[] = [];
    let state: ClientState = initialState;

    const client = new RealtimeClient({
      socket,
      session,
      url: "wss://nexus.test/ws/client",
      network: new FakeNetwork(),
      timers,
      random: () => 0.5,
      now: () => new Date("2026-09-02T12:00:00.000Z"),
      dispatch: (action) => {
        actions.push(action);
        state = reduce(state, action);
      },
    });

    return { client, socket, timers, actions, state: () => state };
  }

  it("n'ouvre aucune socket sans appareil rattaché", async () => {
    const { session } = makeSession();
    await session.login("alex@example.test", "mot de passe");

    const h = makeRealtime(session);
    await h.client.start();

    expect(h.socket.state).toBe("idle");
    expect(h.socket.sent).toHaveLength(0);
    expect(h.client.state).toBe("offline");
  });

  it("ne programme pas de reconnexion : aucun réseau ne fera surgir un appareil", async () => {
    // Le défaut de la première correction : la socket était ouverte puis
    // refermée, ce qui déclenchait la reconnexion automatique. L'application
    // affichait « connexion perdue » en boucle pour une cause que le réseau ne
    // réparerait jamais.
    const { session } = makeSession();
    await session.login("alex@example.test", "mot de passe");

    const h = makeRealtime(session);
    await h.client.start();

    expect(h.timers.pending.size).toBe(0);
    expect(h.actions.filter((a) => a.kind === "connection").map((a) => a.state)).not.toContain(
      "reconnecting",
    );
  });

  it("dit pourquoi, au lieu de laisser un écran vide", async () => {
    const { session } = makeSession();
    await session.login("alex@example.test", "mot de passe");

    const h = makeRealtime(session);
    await h.client.start();

    expect(h.state().lastError?.code).toBe("CLIENT_NO_DEVICE");
  });

  it("ouvre et annonce l'appareil dès qu'il est rattaché", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-neuf" } } });

    await session.login("alex@example.test", "mot de passe");

    const h = makeRealtime(session);
    await h.client.start();
    expect(h.socket.sent).toHaveLength(0);

    await session.ensureDevice(IPHONE);
    await h.client.start();

    expect(h.client.state).toBe("connected");
    expect(h.socket.lastOfType("client.hello")?.payload.deviceId).toBe("device-neuf");
  });
});

describe("7. déconnexion", () => {
  it("efface le rattachement d'appareil avec les jetons", async () => {
    // Le laisser derrière soi était un piège : le compte suivant reprenait
    // l'appareil du précédent et se voyait refuser la poignée de main.
    const { http, storage, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");
    await session.ensureDevice(IPHONE);
    await session.logout();

    expect(session.deviceId).toBeNull();
    expect(session.isAuthenticated).toBe(false);
    expect(storage.removed).toContain("nexus.device");
    expect(storage.values.has("nexus.device")).toBe(false);
  });

  it("efface aussi quand le cœur est injoignable", async () => {
    // Un utilisateur qui se déconnecte dans le métro doit voir sa session
    // disparaître de l'appareil, quoi qu'en pense le réseau.
    const { http, storage, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");
    await session.ensureDevice(IPHONE);

    http.failNext = true;
    await session.logout();

    expect(storage.removed).toContain("nexus.device");
  });
});

describe("8. reconnexion et changement de compte", () => {
  it("le même compte retrouve son appareil", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device()));

    await session.login("alex@example.test", "mot de passe");
    await session.ensureDevice(IPHONE);
    await session.login("alex@example.test", "mot de passe");

    expect(session.deviceId).toBe("device-iphone");
  });

  it("un autre compte n'hérite pas de l'appareil du précédent", async () => {
    // Sans cette règle, le second compte présenterait au cœur un appareil qui ne
    // lui appartient pas. Le cœur refuserait — il vérifie la propriété — mais le
    // client resterait bloqué sans que rien n'explique pourquoi.
    const { http, storage, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device()));

    await session.login("alex@example.test", "mot de passe");
    await session.ensureDevice(IPHONE);
    expect(session.deviceId).toBe("device-iphone");

    // La réponse porte un autre utilisateur : c'est le seul signal fiable.
    const sarah = loginResponse({ access: "jeton-sarah", refresh: "rafraichissement-sarah" });
    (sarah.body as { data: { user: { id: string } } }).data.user.id = "u2";
    http.on("POST", "/api/v1/auth/login", sarah);

    await session.login("sarah@exemple.fr", "mot de passe");

    expect(session.deviceId).toBeNull();
    expect(storage.removed).toContain("nexus.device");
  });

  it("ne détruit pas un rattachement valide faute d'information", async () => {
    // Un trousseau écrit par une version antérieure ne porte pas d'utilisateur.
    // L'absence d'information n'est pas une preuve de changement de compte.
    const storage = new FakeSecureStorage();
    storage.values.set("nexus.access", "a");
    storage.values.set("nexus.refresh", "r");
    storage.values.set("nexus.device", "device-historique");

    const { session } = makeSession(storage);
    await session.restore();
    await session.login("alex@example.test", "mot de passe");

    expect(session.deviceId).toBe("device-historique");
  });
});

describe("9. aucun privilège accordé au client", () => {
  it("n'accorde aucune permission et ne demande pas le rôle exécutant", async () => {
    // Un appareil ne décide pas de ce qu'il a le droit de faire. La preuve tient
    // dans le corps de la requête : rôle client, permissions vides.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");
    await session.ensureDevice(IPHONE);

    const body = http.requests.at(-1)?.body as { role: string; grantedPermissions: string[] };
    expect(body.role).toBe("CLIENT");
    expect(body.grantedPermissions).toEqual([]);
  });

  it("ne s'approuve pas lui-même", async () => {
    // Aucune requête d'approbation ne part du client : l'appareil reste PENDING
    // jusqu'à ce qu'un client déjà approuvé l'approuve.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");
    await session.ensureDevice(IPHONE);

    expect(http.requests.some((r) => r.path.includes("/trust"))).toBe(false);
  });

  it("ne se réenregistre pas en exécutant", async () => {
    // Le rôle est demandé, jamais imposé — et le rattachement automatique ne
    // doit pas devenir un chemin détourné vers le droit d'exécuter.
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");
    await session.ensureDevice(IPHONE);

    const roles = http.requests
      .filter((r) => r.method === "POST" && r.path === "/api/v1/devices")
      .map((r) => (r.body as { role: string }).role);
    expect(roles).toEqual(["CLIENT"]);
  });
});

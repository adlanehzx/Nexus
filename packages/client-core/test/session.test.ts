import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session.js";
import { FakeHttpClient, FakeSecureStorage, TOKENS, loginResponse } from "./fixtures.js";

/**
 * Session et jetons.
 *
 * Deux propriétés dominent ce fichier, et ce sont celles qui cassent en
 * production quand on ne les teste pas : les jetons vivent dans le **trousseau**,
 * et le rafraîchissement est **sérialisé**. Dix requêtes qui échouent en même
 * temps ne doivent produire qu'une rotation — sinon le serveur voit un jeton
 * rejoué et ferme tout, à juste titre.
 */

function makeSession(options: { onSignedOut?: (reason: string) => void } = {}) {
  const http = new FakeHttpClient();
  const storage = new FakeSecureStorage();
  const session = new SessionManager({
    http,
    storage,
    ...(options.onSignedOut === undefined ? {} : { onSignedOut: options.onSignedOut }),
  });

  return { http, storage, session };
}

describe("connexion", () => {
  it("ouvre une session et range les jetons dans le trousseau", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());

    await session.login("alex@example.test", "un mot de passe suffisant");

    expect(session.isAuthenticated).toBe(true);
    expect(storage.values.get("nexus.access")).toBe(TOKENS.access);
    expect(storage.values.get("nexus.refresh")).toBe(TOKENS.refresh);
  });

  it("refuse de mauvais identifiants", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", {
      status: 401,
      body: {
        error: { code: "INVALID_CREDENTIALS", message: "Adresse ou mot de passe incorrect." },
      },
    });

    await expect(session.login("alex@example.test", "mauvais")).rejects.toMatchObject({
      code: "CLIENT_LOGIN_FAILED",
    });
    expect(session.isAuthenticated).toBe(false);
  });

  it("ne conserve jamais le mot de passe", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());

    await session.login("alex@example.test", "MonMotDePasse2026");

    expect(JSON.stringify([...storage.values.values()])).not.toContain("MonMotDePasse2026");
  });

  it("restaure une session depuis le trousseau au démarrage", async () => {
    const { storage, session } = makeSession();
    await storage.set("nexus.access", TOKENS.access);
    await storage.set("nexus.refresh", TOKENS.refresh);
    await storage.set("nexus.device", "device-iphone");

    expect(await session.restore()).toBe(true);
    expect(session.accessToken()).toBe(TOKENS.access);
    expect(session.deviceId).toBe("device-iphone");
  });

  it("ne restaure rien quand le trousseau est vide", async () => {
    const { session } = makeSession();
    expect(await session.restore()).toBe(false);
    expect(session.isAuthenticated).toBe(false);
  });
});

describe("rafraîchissement", () => {
  it("fait tourner le jeton et le range", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 200,
      body: { data: { accessToken: "acces-2", refreshToken: "rafraichissement-2" } },
    });

    await session.login("alex@example.test", "mot de passe");
    const token = await session.refresh();

    expect(token).toBe("acces-2");
    expect(storage.values.get("nexus.refresh")).toBe("rafraichissement-2");
  });

  it("ne lance qu'une rotation pour dix appels simultanés", async () => {
    // C'est le bogue vicieux de ce type de client : dix requêtes qui échouent
    // ensemble déclenchent dix rotations, dont neuf présentent un jeton déjà
    // consommé. Le serveur, qui traite un rejeu comme un vol, ferme tout.
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 200,
      body: { data: { accessToken: "acces-2", refreshToken: "rafraichissement-2" } },
    });

    await session.login("alex@example.test", "mot de passe");

    const results = await Promise.all(Array.from({ length: 10 }, () => session.refresh()));

    expect(http.countOf("POST", "/api/v1/auth/refresh")).toBe(1);
    expect(new Set(results)).toEqual(new Set(["acces-2"]));
  });

  it("vide le trousseau quand le serveur refuse la rotation", async () => {
    const reasons: string[] = [];
    const { http, storage, session } = makeSession({
      onSignedOut: (reason) => reasons.push(reason),
    });

    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 401,
      body: { error: { code: "SESSION_REVOKED" } },
    });

    await session.login("alex@example.test", "mot de passe");
    await expect(session.refresh()).rejects.toMatchObject({ code: "CLIENT_NOT_AUTHENTICATED" });

    expect(session.isAuthenticated).toBe(false);
    expect(storage.removed).toContain("nexus.access");
    expect(reasons).toEqual(["rafraîchissement refusé"]);
  });

  it("permet une nouvelle rotation après la première", async () => {
    // La garde de concurrence ne doit pas rester verrouillée : elle sérialise,
    // elle ne bloque pas.
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on(
      "POST",
      "/api/v1/auth/refresh",
      { status: 200, body: { data: { accessToken: "a2", refreshToken: "r2" } } },
      { status: 200, body: { data: { accessToken: "a3", refreshToken: "r3" } } },
    );

    await session.login("alex@example.test", "mot de passe");

    expect(await session.refresh()).toBe("a2");
    expect(await session.refresh()).toBe("a3");
  });
});

describe("requêtes authentifiées", () => {
  it("porte le jeton", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("GET", "/api/v1/devices", { status: 200, body: { data: [] } });

    await session.login("alex@example.test", "mot de passe");
    await session.authorizedRequest({ method: "GET", path: "/api/v1/devices" });

    expect(http.requests.at(-1)?.authorization).toBe(`Bearer ${TOKENS.access}`);
  });

  it("rafraîchit et réessaie une seule fois sur 401", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 200,
      body: { data: { accessToken: "acces-2", refreshToken: "r2" } },
    });
    http.on(
      "GET",
      "/api/v1/devices",
      { status: 401, body: { error: { code: "TOKEN_EXPIRED" } } },
      { status: 200, body: { data: [{ id: "d1" }] } },
    );

    await session.login("alex@example.test", "mot de passe");
    const response = await session.authorizedRequest({ method: "GET", path: "/api/v1/devices" });

    expect(response.status).toBe(200);
    expect(http.requests.at(-1)?.authorization).toBe("Bearer acces-2");
  });

  it("ne boucle pas si le jeton neuf est refusé lui aussi", async () => {
    // Si le second 401 relançait une rotation, une panne d'autorisation
    // deviendrait une tempête de requêtes.
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 200,
      body: { data: { accessToken: "acces-2", refreshToken: "r2" } },
    });
    http.on("GET", "/api/v1/devices", { status: 401, body: { error: { code: "FORBIDDEN" } } });

    await session.login("alex@example.test", "mot de passe");
    const response = await session.authorizedRequest({ method: "GET", path: "/api/v1/devices" });

    expect(response.status).toBe(401);
    expect(http.countOf("GET", "/api/v1/devices")).toBe(2);
    expect(http.countOf("POST", "/api/v1/auth/refresh")).toBe(1);
  });
});

describe("déconnexion", () => {
  it("vide le trousseau", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/logout", { status: 200, body: { data: { closed: true } } });

    await session.login("alex@example.test", "mot de passe");
    await session.logout();

    expect(session.isAuthenticated).toBe(false);
    expect(storage.removed).toEqual(expect.arrayContaining(["nexus.access", "nexus.refresh"]));
  });

  it("vide le trousseau même si le serveur est injoignable", async () => {
    // Appuyer sur « se déconnecter » dans le métro doit faire disparaître la
    // session de l'appareil, quoi qu'en pense le réseau.
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());

    await session.login("alex@example.test", "mot de passe");
    http.failNext = true;
    await session.logout();

    expect(session.isAuthenticated).toBe(false);
    expect(storage.removed).toContain("nexus.access");
  });
});

describe("enregistrement de l'appareil", () => {
  it("envoie la clé publique et retient l'identifiant", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-iphone" } } });

    await session.login("alex@example.test", "mot de passe");
    const deviceId = await session.registerDevice({
      name: "iPhone d'Alex",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
    });

    expect(deviceId).toBe("device-iphone");
    expect(storage.values.get("nexus.device")).toBe("device-iphone");

    const body = http.requests.at(-1)?.body as { type: string; role: string; publicKeyPem: string };
    expect(body).toMatchObject({ type: "IPHONE", role: "CLIENT" });
    // Seule la clé publique part.
    expect(body.publicKeyPem).not.toContain("PRIVATE");
  });

  it("s'enregistre comme CLIENT par défaut", async () => {
    // Un appareil qui ne dit rien de lui-même est un client : le rôle
    // d'exécutant se demande explicitement, il ne s'obtient pas par omission.
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");
    await session.registerDevice({ name: "iPhone", publicKeyPem: "clé" });

    expect((http.requests.at(-1)?.body as { role: string }).role).toBe("CLIENT");
  });

  it("ne s'accorde jamais de permission", async () => {
    // Quel que soit le rôle demandé, `grantedPermissions` part vide : un
    // appareil ne décide pas de ce qu'il a le droit de faire. C'est l'utilisateur
    // qui l'accorde, depuis un client déjà approuvé.
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "mot de passe");
    await session.registerDevice({
      name: "Portable",
      publicKeyPem: "clé",
      type: "WINDOWS_PC",
      platform: "WINDOWS",
      role: "BOTH",
    });

    const body = http.requests.at(-1)?.body as {
      role: string;
      type: string;
      grantedPermissions: string[];
    };
    expect(body).toMatchObject({ role: "BOTH", type: "WINDOWS_PC" });
    expect(body.grantedPermissions).toEqual([]);
  });

  it("se rattache à un appareil déjà enregistré sans en créer un second", async () => {
    // Le chemin du portable Windows : sa ligne d'appareil existe déjà, créée
    // par le démon exécutant qui détient la clé de la machine. La fenêtre
    // reprend le même identifiant — un second appareil ferait apparaître deux
    // « Portable » dans la flotte de l'utilisateur.
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());

    await session.login("alex@example.test", "mot de passe");
    const avant = http.countOf("POST", "/api/v1/devices");

    await session.bindDevice("device-portable");

    expect(session.deviceId).toBe("device-portable");
    expect(storage.values.get("nexus.device")).toBe("device-portable");
    expect(http.countOf("POST", "/api/v1/devices")).toBe(avant);
  });
});

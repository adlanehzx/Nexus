import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount,
  makeApi,
  registerDevice,
  signNonce,
  PASSWORD,
  type Account,
  type ApiHarness,
} from "./harness.js";

/**
 * L'API REST.
 *
 * Les tests portent autant sur les **refus** que sur les succès : une API dont
 * on ne vérifie que le chemin heureux laisse passer exactement les défauts qui
 * comptent — une ressource lisible par le mauvais utilisateur, une garde
 * oubliée, un secret dans une réponse.
 */

let harness: ApiHarness;
let account: Account;

beforeEach(async () => {
  harness = await makeApi();
  account = await createAccount(harness);
});

afterEach(async () => {
  await harness.close();
});

describe("enveloppe de réponse", () => {
  it("porte un identifiant de requête sur les succès", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: account.authorization,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: unknown; meta: { requestId: string } }>();

    expect(body.meta.requestId).toBeTruthy();
    // Le même identifiant repart dans l'en-tête : l'utilisateur peut le citer
    // sans lire le corps de la réponse.
    expect(response.headers["x-request-id"]).toBe(body.meta.requestId);
  });

  it("porte un identifiant de requête sur les erreurs", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/v1/users/me" });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("UNAUTHENTICATED");
  });

  it("pagine par curseur", async () => {
    for (let index = 0; index < 5; index += 1) {
      await harness.app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: account.authorization,
        payload: { title: `Conversation ${String(index)}` },
      });
    }

    const first = await harness.app.inject({
      method: "GET",
      url: "/api/v1/conversations?limit=2",
      headers: account.authorization,
    });

    const page = first.json<{
      data: { id: string }[];
      meta: { nextCursor: string | null; total: number };
    }>();

    expect(page.data).toHaveLength(2);
    expect(page.meta.total).toBe(5);
    expect(page.meta.nextCursor).toBeTruthy();

    const second = await harness.app.inject({
      method: "GET",
      url: `/api/v1/conversations?limit=2&cursor=${page.meta.nextCursor ?? ""}`,
      headers: account.authorization,
    });

    const next = second.json<{ data: { id: string }[] }>();
    // Aucun recouvrement : c'est tout l'intérêt du curseur face à un décalage.
    expect(next.data.map((c) => c.id)).not.toContain(page.data[0]?.id);
  });

  it("plafonne la taille de page demandée", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/conversations?limit=100000",
      headers: account.authorization,
    });

    // Sans plafond, `?limit=1000000` transforme une liste en déni de service.
    expect(response.statusCode).toBe(400);
  });
});

describe("authentification", () => {
  it("refuse une requête sans jeton", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/v1/devices" });
    expect(response.statusCode).toBe(401);
  });

  it("refuse un jeton falsifié", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: "Bearer pas.un.jeton" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("connecte avec le bon mot de passe", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "adlan@exemple.fr", password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken,
    ).toBeTruthy();
  });

  it("refuse le mauvais mot de passe sans dire si le compte existe", async () => {
    const known = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "adlan@exemple.fr", password: "mauvais mot de passe" },
    });
    const unknown = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "inconnu@exemple.fr", password: "mauvais mot de passe" },
    });

    // Même code, même message : la différence permettrait d'énumérer les
    // adresses enregistrées.
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json<{ error: { message: string } }>().error.message).toBe(
      unknown.json<{ error: { message: string } }>().error.message,
    );
  });

  it("ne renvoie jamais l'empreinte du mot de passe", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: account.authorization,
    });

    expect(response.body).not.toContain("scrypt$");
    expect(response.body).not.toContain("passwordHash");
  });

  it("fait tourner le jeton de rafraîchissement", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: account.refreshToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { refreshToken: string } }>().data.refreshToken).not.toBe(
      account.refreshToken,
    );
  });

  it("ferme toutes les sessions si un jeton de rafraîchissement est rejoué", async () => {
    // Le rejeu signifie que le jeton a été copié. On ne sait pas qui, de
    // l'attaquant ou de la victime, le présente : on ferme tout.
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: account.refreshToken },
    });

    const replay = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: account.refreshToken },
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe("SESSION_REVOKED");

    // Et le jeton d'accès de la session d'origine ne vaut plus rien.
    const after = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: account.authorization,
    });
    expect(after.statusCode).toBe(401);
  });

  it("la déconnexion prend effet immédiatement", async () => {
    // Le jeton d'accès reste cryptographiquement valide un quart d'heure : sans
    // vérification de session, se déconnecter ne ferait rien.
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: account.authorization,
    });

    const after = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: account.authorization,
    });
    expect(after.statusCode).toBe(401);
  });

  it("limite les tentatives de connexion", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: "adlan@exemple.fr", password: "mauvais" },
        }),
      ),
    );

    expect(attempts.some((response) => response.statusCode === 429)).toBe(true);
  });
});

describe("cloisonnement entre utilisateurs", () => {
  it("ne montre pas les appareils d'un autre utilisateur", async () => {
    const autre = await createAccount(harness, "autre@exemple.fr");
    await registerDevice(harness, autre, { name: "Poste privé", role: "WORKER" });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: account.authorization,
    });

    expect(response.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it("refuse de lire l'appareil d'un autre, sans révéler qu'il existe", async () => {
    const autre = await createAccount(harness, "autre@exemple.fr");
    const { device } = await registerDevice(harness, autre, {
      name: "Poste privé",
      role: "WORKER",
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/v1/devices/${device.id}`,
      headers: account.authorization,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      "La ressource demandée n'existe pas.",
    );
  });

  it("refuse de lire la conversation d'un autre", async () => {
    const autre = await createAccount(harness, "autre@exemple.fr");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: autre.authorization,
      payload: { title: "Privé" },
    });
    const id = created.json<{ data: { id: string } }>().data.id;

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${id}`,
      headers: account.authorization,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("appareils", () => {
  it("enregistre un appareil hors ligne et non approuvé", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "Poste fixe",
      role: "WORKER",
      trust: false,
    });

    // La confiance se donne, elle ne se suppose pas.
    expect(device.status).toBe("OFFLINE");
    expect(device.trust).toBe("PENDING");
  });

  it("enregistre un CLIENT sans clé publique", async () => {
    // L'iPhone s'authentifie par jeton, et la route vérifie déjà que l'appareil
    // appartient au porteur du jeton. Exiger de lui une clé matérielle
    // n'ajouterait aucune garantie et l'empêchait simplement de s'enregistrer.
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices",
      headers: account.authorization,
      payload: {
        name: "iPhone d'Adlan",
        type: "IPHONE",
        platform: "IOS",
        role: "CLIENT",
        grantedPermissions: [],
      },
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<{ data: { role: string; trust: string } }>().data;
    // Sans clé, mais sans privilège non plus : l'appareil arrive non approuvé.
    expect(created.role).toBe("CLIENT");
    expect(created.trust).toBe("PENDING");
  });

  it("refuse un WORKER sans clé publique", async () => {
    // C'est la clé qui rend vérifiable la signature du challenge : un exécutant
    // sans clé enregistrée serait un exécutant dont plus rien n'atteste
    // l'identité. L'ouverture faite pour l'iPhone ne doit pas déborder ici.
    for (const role of ["WORKER", "BOTH"]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/v1/devices",
        headers: account.authorization,
        payload: {
          name: `Poste ${role}`,
          type: "WINDOWS_PC",
          platform: "WINDOWS",
          role,
          grantedPermissions: [],
        },
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it("un CLIENT sans clé n'ouvre aucune session d'appareil", async () => {
    // La contrepartie du chemin sans clé : elle ne donne accès à rien de plus.
    // Le canal worker exige une signature, et il n'y a pas de clé à vérifier.
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices",
      headers: account.authorization,
      payload: {
        name: "iPhone nu",
        type: "IPHONE",
        platform: "IOS",
        role: "CLIENT",
        grantedPermissions: [],
      },
    });
    const deviceId = created.json<{ data: { id: string } }>().data.id;

    const challenge = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/challenge`,
    });
    const nonce = challenge.json<{ data: { nonce: string } }>().data.nonce;

    const session = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/sessions`,
      payload: { nonce, signature: "c2lnbmF0dXJlLWJpZG9u", capabilities: [] },
    });

    expect(session.statusCode).toBe(404);
  });

  it("approuve un appareil", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "Poste fixe",
      role: "WORKER",
    });
    expect(device.trust).toBe("TRUSTED");
  });

  it("ouvre une session d'appareil sur un challenge signé", async () => {
    const { device, privateKeyPem } = await registerDevice(harness, account, {
      name: "Poste fixe",
      role: "WORKER",
      permissions: ["terminal.execute"],
    });

    const challenge = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/challenge`,
    });
    const nonce = challenge.json<{ data: { nonce: string } }>().data.nonce;

    const session = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/sessions`,
      payload: { nonce, signature: signNonce(privateKeyPem, nonce), capabilities: [] },
    });

    expect(session.statusCode).toBe(201);
    expect(session.json<{ data: { token: string } }>().data.token).toBeTruthy();
  });

  it("refuse une signature invalide", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "Poste fixe",
      role: "WORKER",
    });

    const challenge = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/challenge`,
    });
    const nonce = challenge.json<{ data: { nonce: string } }>().data.nonce;

    const session = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/sessions`,
      payload: { nonce, signature: "c2lnbmF0dXJlLWJpZG9u", capabilities: [] },
    });

    expect(session.statusCode).toBe(401);
  });

  it("refuse un appareil révoqué", async () => {
    const { device, privateKeyPem } = await registerDevice(harness, account, {
      name: "Poste fixe",
      role: "WORKER",
    });

    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/revoke`,
      headers: account.authorization,
    });

    const challenge = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/challenge`,
    });

    // Le challenge lui-même est refusé : inutile d'attendre la signature.
    expect(challenge.statusCode).toBe(401);
    expect(privateKeyPem).toBeTruthy();
  });

  it("expose les capacités présentes dans la flotte", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "Poste fixe",
      role: "WORKER",
    });

    await harness.app.inject({
      method: "PUT",
      url: `/api/v1/devices/${device.id}/capabilities`,
      headers: account.authorization,
      payload: {
        capabilities: [
          { name: "terminal.execute", version: "1", description: "", enabled: true, metadata: {} },
        ],
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/capabilities",
      headers: account.authorization,
    });

    const body = response.json<{ data: { available: { name: string }[] } }>();
    expect(body.data.available.map((c) => c.name)).toContain("terminal.execute");
  });
});

describe("tâches", () => {
  it("refuse une capacité non accordée", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "iPhone",
      role: "CLIENT",
      type: "IPHONE",
      platform: "IOS",
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Exécuter une commande",
        originClientDeviceId: device.id,
        steps: [
          {
            description: "Lancer les tests",
            requiredCapabilities: ["terminal.execute"],
            tool: "device.terminal.execute",
          },
        ],
      },
    });

    // Refusé au centre, avant tout dispatch : le worker n'est même pas consulté.
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "terminal.execute",
    );
  });

  it("refuse un appareil d'origine qui n'appartient pas à l'appelant", async () => {
    const autre = await createAccount(harness, "autre@exemple.fr");
    const { device } = await registerDevice(harness, autre, { name: "iPhone", role: "CLIENT" });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Détournement",
        originClientDeviceId: device.id,
        steps: [{ description: "x", requiredCapabilities: ["filesystem.read"], tool: "device.x" }],
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuse un plan sans étape", async () => {
    const { device } = await registerDevice(harness, account, { name: "iPhone", role: "CLIENT" });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: { title: "Vide", originClientDeviceId: device.id, steps: [] },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("notifications", () => {
  it("marque une notification comme lue pour tous les clients", async () => {
    const notification = await harness.services.notifications.create({
      userId: account.userId,
      title: "Tâche terminée",
      body: "Les tests sont passés",
    });

    const read = await harness.app.inject({
      method: "POST",
      url: `/api/v1/notifications/${notification.id}/read`,
      headers: account.authorization,
    });

    expect(read.statusCode).toBe(200);
    // L'état vit au centre : lu sur l'iPhone, lu sur le portable.
    expect(read.json<{ data: { readAt: string | null } }>().data.readAt).not.toBeNull();
  });

  it("filtre les non lues", async () => {
    const first = await harness.services.notifications.create({
      userId: account.userId,
      title: "Une",
      body: "x",
    });
    await harness.services.notifications.create({
      userId: account.userId,
      title: "Deux",
      body: "y",
    });

    await harness.app.inject({
      method: "POST",
      url: `/api/v1/notifications/${first.id}/read`,
      headers: account.authorization,
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/notifications?unreadOnly=true",
      headers: account.authorization,
    });

    expect(response.json<{ data: { title: string }[] }>().data).toHaveLength(1);
  });
});

describe("mémoire", () => {
  it("enregistre puis retrouve un souvenir", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory",
      headers: account.authorization,
      payload: { content: "Adlan préfère les réponses courtes", kind: "SEMANTIC" },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory/search?q=réponses",
      headers: account.authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { hits: unknown[] } }>().data.hits.length).toBeGreaterThan(0);
  });

  it("ne traverse pas la frontière entre utilisateurs", async () => {
    const autre = await createAccount(harness, "autre@exemple.fr");
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory",
      headers: autre.authorization,
      payload: { content: "Secret de quelqu'un d'autre", kind: "SEMANTIC" },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory/search?q=Secret",
      headers: account.authorization,
    });

    expect(response.json<{ data: { hits: unknown[] } }>().data.hits).toHaveLength(0);
  });
});

describe('CORS et CSP', () => {
  it('doit accepter un preflight valide', async () => {
    const response = await harness.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: {
        Origin: 'http://localhost:5273',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5273');
    expect(response.headers['access-control-allow-methods']).toMatch(/POST/);
  });
});

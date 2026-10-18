import { describe, expect, it } from "vitest";
import { FetchHttpClient, RequestBlockedError } from "../src/http.js";

/**
 * Ce que le client fait d'un `fetch` qui n'atteint jamais le réseau.
 *
 * `fetch` rend le même « Failed to fetch » que le cœur soit éteint, que CORS
 * refuse l'origine, ou que la politique de sécurité du contenu ait bloqué la
 * connexion. Sur le poste Windows, c'est la troisième qui a coûté le plus cher :
 * rien ne part, rien n'apparaît côté serveur, et l'écran affiche trois mots.
 */

function clientAvec(fetchImpl: typeof fetch): FetchHttpClient {
  const client = new FetchHttpClient("https://nexus.test");
  // `FetchHttpClient` capture le `fetch` global ; on le remplace le temps du test.
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  Reflect.set(client, "restaurer", () => {
    globalThis.fetch = original;
  });
  return client;
}

describe("requête bloquée avant le réseau", () => {
  it("nomme les trois causes possibles et l'adresse visée", async () => {
    const client = clientAvec(() => Promise.reject(new TypeError("Failed to fetch")));

    try {
      await client.request({ method: "GET", path: "/api/v1/health" });
      expect.unreachable("la requête aurait dû échouer");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBlockedError);
      const message = (error as Error).message;

      expect(message).toContain("https://nexus.test/api/v1/health");
      expect(message).toContain("CORS");
      expect(message).toContain("sécurité du contenu");
    } finally {
      (Reflect.get(client, "restaurer") as () => void)();
    }
  });

  it("conserve la cause d'origine", async () => {
    const cause = new TypeError("Failed to fetch");
    const client = clientAvec(() => Promise.reject(cause));

    try {
      await client.request({ method: "GET", path: "/x" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).cause).toBe(cause);
    } finally {
      (Reflect.get(client, "restaurer") as () => void)();
    }
  });

  it("n'expose ni en-tête, ni jeton, ni corps", async () => {
    // Le message est lu par un humain, parfois collé dans un ticket. L'adresse
    // figure dans le paquet livré ; le jeton, non.
    const client = clientAvec(() => Promise.reject(new TypeError("Failed to fetch")));

    try {
      await client.request({
        method: "POST",
        path: "/api/v1/auth/login",
        headers: { authorization: "Bearer jeton-tres-secret" },
        body: { password: "mot-de-passe-secret" },
      });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("jeton-tres-secret");
      expect(message).not.toContain("mot-de-passe-secret");
      expect(message).not.toContain("Bearer");
    } finally {
      (Reflect.get(client, "restaurer") as () => void)();
    }
  });

  it("laisse passer une annulation demandée", async () => {
    // Un écran quitté annule ses requêtes. Le transformer en erreur réseau
    // afficherait une panne là où il n'y a qu'un changement de page.
    const abort = new Error("annulé");
    abort.name = "AbortError";
    const client = clientAvec(() => Promise.reject(abort));

    try {
      await client.request({ method: "GET", path: "/x" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBe(abort);
      expect(error).not.toBeInstanceOf(RequestBlockedError);
    } finally {
      (Reflect.get(client, "restaurer") as () => void)();
    }
  });

  it("une réponse d'erreur du serveur n'est pas une requête bloquée", async () => {
    // 500 signifie que la requête est arrivée. La confondre avec un blocage
    // enverrait l'utilisateur chercher un problème de configuration inexistant.
    const client = clientAvec(() =>
      Promise.resolve(new Response(JSON.stringify({ error: {} }), { status: 500 })),
    );

    try {
      const reponse = await client.request({ method: "GET", path: "/x" });
      expect(reponse.status).toBe(500);
    } finally {
      (Reflect.get(client, "restaurer") as () => void)();
    }
  });
});

describe("en-tête de contenu", () => {
  /** Capture la requête réellement composée, sans jamais toucher au réseau. */
  function capture() {
    const vues: RequestInit[] = [];
    const client = clientAvec((_url, init) => {
      vues.push(init ?? {});
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    return { client, vues };
  }

  it("n'annonce pas de JSON quand il n'y a pas de corps", async () => {
    // Le cœur prend l'en-tête au mot : il cherche un corps, n'en trouve pas, et
    // répond 400. Approuver un appareil — une requête qui ne porte rien —
    // échouait donc systématiquement, et avec elle le déblocage du premier
    // iPhone, qui s'enregistre en attente d'approbation.
    const { client, vues } = capture();

    await client.request({ method: "POST", path: "/api/v1/devices/d1/trust" });

    const headers = vues[0]?.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(vues[0]?.body).toBeUndefined();
  });

  it("l'annonce dès qu'il y a un corps", async () => {
    const { client, vues } = capture();

    await client.request({ method: "POST", path: "/api/v1/auth/login", body: { email: "a@b.c" } });

    const headers = vues[0]?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(vues[0]?.body).toBe(JSON.stringify({ email: "a@b.c" }));
  });

  it("laisse passer l'autorisation dans les deux cas", async () => {
    // Le jeton n'a rien à voir avec le corps : il doit accompagner la requête
    // qu'elle en porte un ou non.
    const { client, vues } = capture();

    await client.request({
      method: "POST",
      path: "/api/v1/devices/d1/trust",
      headers: { authorization: "Bearer jeton" },
    });

    expect((vues[0]?.headers as Record<string, string>).authorization).toBe("Bearer jeton");
  });
});

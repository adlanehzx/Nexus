import type { HttpClient, HttpResponse } from "./ports.js";

/**
 * Client HTTP au-dessus de `fetch`.
 *
 * Partagé par tous les clients — iPhone, poste Windows, tableau de bord. Trois
 * implémentations identiques dans trois applications finissent toujours par
 * diverger sur un détail : celle qui n'attrape pas l'erreur d'analyse JSON, ou
 * celle qui oublie le `content-type`.
 *
 * `fetch` est global dans React Native, dans un navigateur et dans Node depuis
 * la 18 : ce fichier n'a donc besoin d'aucun adaptateur de plateforme, et reste
 * à sa place dans un paquet sans dépendance.
 */
export class FetchHttpClient implements HttpClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(input: Parameters<HttpClient["request"]>[0]): Promise<HttpResponse> {
    const url = `${this.#baseUrl}${input.path}`;

    // `content-type: application/json` **uniquement s'il y a du JSON**.
    //
    // L'annoncer sur une requête sans corps n'est pas une coquetterie : le cœur
    // le prend au mot, cherche un corps à analyser, n'en trouve pas et répond
    // 400. Toutes les actions qui ne portent rien en tombaient — approuver un
    // appareil, le révoquer, marquer une notification lue. C'est-à-dire, entre
    // autres, **l'approbation dont dépend le premier iPhone** : il s'enregistre,
    // arrive en attente, et le geste qui devait le débloquer échouait.
    const headers = {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...input.headers,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (cause) {
      // Une annulation demandée n'est pas une panne : on la laisse remonter
      // telle quelle, sinon un écran quitté afficherait une erreur réseau.
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new RequestBlockedError(url, cause);
    }

    // 204, page d'erreur d'un proxy, coupure en cours de corps : rien de tout
    // cela ne doit faire échouer l'appelant sur une exception d'analyse.
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }
}

/**
 * Coffre volatil.
 *
 * Il **oublie tout** à la fermeture de l'onglet, et c'est délibéré : écrire un
 * jeton de rafraîchissement dans `localStorage` le rendrait lisible par
 * n'importe quel script de la page, pour trente jours. Se reconnecter est un
 * inconvénient ; un jeton de longue durée en clair est une faille.
 */
export class VolatileStorage {
  readonly #values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.#values.delete(key);
    return Promise.resolve();
  }
}

/**
 * Requête qui n'a jamais atteint le réseau.
 *
 * `fetch` rend le même « Failed to fetch » lapidaire pour trois causes très
 * différentes : le cœur est éteint, l'origine est refusée par CORS, ou la
 * **politique de sécurité du contenu a bloqué la connexion**. C'est la dernière
 * qui coûte le plus cher à diagnostiquer : rien n'apparaît dans le journal du
 * serveur, puisque rien n'est parti.
 *
 * On nomme donc les trois pistes, avec l'adresse visée. **L'adresse n'est pas un
 * secret** — elle est inscrite dans le paquet livré — et aucun en-tête, aucun
 * jeton, aucun corps de requête n'est joint.
 */
export class RequestBlockedError extends Error {
  readonly code = "CLIENT_REQUEST_BLOCKED";
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      `Impossible de joindre ${url}. Trois causes possibles : le cœur NEXUS ne répond pas, ` +
        `son origine n'est pas autorisée (CORS), ou la politique de sécurité du contenu a ` +
        `bloqué la connexion — la CSP n'autorise que https:// et wss:// hors développement.`,
      { cause },
    );
    this.name = "RequestBlockedError";
    this.url = url;
  }
}

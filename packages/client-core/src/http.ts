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
    const response = await fetch(`${this.#baseUrl}${input.path}`, {
      method: input.method,
      headers: { "content-type": "application/json", ...input.headers },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

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

import { AppError, type ErrorSeverity } from "@nexus/shared";

/**
 * Adresses du cœur, validées.
 *
 * ## Pourquoi ce fichier existe
 *
 * Les deux clients dérivaient l'URL du canal temps réel de la même façon :
 *
 * ```ts
 * const SOCKET_URL = BACKEND_URL.replace(/^http/, "ws") + "/ws/client";
 * ```
 *
 * C'est juste, et c'est insuffisant. Un `NEXUS_URL` mal renseigné en
 * `http://nexus.exemple.fr` devient `ws://nexus.exemple.fr` — un canal en clair
 * qui transporte le jeton d'accès de l'utilisateur dans sa première trame, sur
 * un Wi-Fi d'hôtel. Rien ne l'empêchait, et rien ne le signalait.
 *
 * Les trois exécutants — Windows, Android, navigateur — refusent déjà une
 * adresse distante en clair. Les clients ne le faisaient pas. C'est le même
 * contrôle, au même endroit du raisonnement, et il manquait du côté qui porte
 * les jetons de l'utilisateur.
 *
 * ## La règle
 *
 * `https` et `wss` partout. `http` et `ws` **uniquement** vers la boucle locale
 * et l'hôte de l'émulateur Android — des adresses qui ne sortent d'aucune
 * machine, et sans lesquelles on ne peut pas développer.
 */

export class InsecureBackendUrlError extends AppError {
  readonly code = "CLIENT_INSECURE_BACKEND_URL";
  readonly httpStatus = 500;
  override readonly severity: ErrorSeverity = "error";

  constructor(url: string, reason: string) {
    super({
      // L'URL figure dans le message : ce n'est pas un secret, et sans elle le
      // message oblige à deviner quelle variable est fautive.
      message: `Adresse du cœur inutilisable (${url}) : ${reason}`,
      userMessage: "La configuration de l'application est invalide. Contactez l'administrateur.",
      context: { url, reason },
    });
  }
}

/** Hôtes pour lesquels le texte clair ne quitte jamais la machine. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  /** L'hôte de développement, vu depuis l'émulateur Android. */
  "10.0.2.2",
]);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/**
 * Valide l'adresse HTTP du cœur et la rend normalisée.
 *
 * @throws {InsecureBackendUrlError} sur une adresse illisible, un protocole
 *   inattendu, ou du texte clair vers un hôte distant.
 */
export function backendHttpUrl(raw: string): string {
  const url = parse(raw);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InsecureBackendUrlError(raw, `protocole « ${url.protocol} » inattendu`);
  }

  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    throw new InsecureBackendUrlError(
      raw,
      "une adresse distante doit être en https:// — un canal en clair expose le jeton de session",
    );
  }

  // Barre finale retirée une fois pour toutes : la concaténer plus loin
  // donnerait `//api/v1/...`, que certains proxys redirigent et d'autres non.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
}

/**
 * URL du canal temps réel, dérivée de l'adresse du cœur.
 *
 * `https` devient `wss`, `http` devient `ws` — et la même règle de texte clair
 * s'applique, parce que c'est ce canal qui porte le jeton d'accès dans sa
 * poignée de main.
 */
export function clientSocketUrl(raw: string, path = "/ws/client"): string {
  const base = backendHttpUrl(raw);
  const socket = base.replace(/^http/, "ws");

  return socket.endsWith(path) ? socket : `${socket}${path}`;
}

function parse(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new InsecureBackendUrlError(raw, "ce n'est pas une URL");
  }
}

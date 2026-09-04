import { WorkerConfigurationError } from "@nexus/worker-core";
import type { Envelope } from "@nexus/protocol";
import type { LinkState, WorkerLink } from "@nexus/worker-core";

/**
 * Le canal réel du téléphone vers le cœur : une WebSocket **sortante**.
 *
 * Même forme que le canal du worker Windows, même protocole, même runtime
 * derrière. Ce qui change est la couche d'exécution : sur Android il n'y a ni
 * `node:ws` ni `node:tls`. React Native fournit un `WebSocket` conforme à la
 * norme du navigateur, adossé à OkHttp côté natif — c'est celui-là qu'on
 * utilise, et il est injecté plutôt qu'importé pour que le canal reste testable
 * sans émulateur.
 *
 * Sortante, et rien d'autre. Ce module ouvre une connexion ; il n'écoute sur
 * aucun port et n'accepte aucune connexion entrante. Un téléphone qui exposerait
 * un service serait joignable depuis tout réseau Wi-Fi auquel il se connecte —
 * c'est exactement ce que la forme du port `WorkerLink` interdit : il y a
 * `connect()`, il n'y a pas `listen()`.
 *
 * ## Ce qui n'est pas ici
 *
 * Poignée de main, signature du challenge, enregistrement des capacités,
 * battements, exécution, annulation, reprise avec attente exponentielle : tout
 * cela vit dans `WorkerRuntime`, partagé avec Windows. Ce fichier transporte des
 * enveloppes. Il n'y a pas de second protocole.
 *
 * ## Vérification de l'identité du cœur
 *
 * Le worker Windows épingle la clé publique du cœur dans `checkServerIdentity`.
 * **React Native n'expose aucun équivalent** : le `WebSocket` du pont ne donne
 * pas accès au certificat présenté. L'épinglage se fait donc là où Android le
 * permet — dans `network_security_config.xml`, par un `<pin-set>` appliqué par
 * la plateforme sous la pile réseau. Voir le README, § « Épingler le cœur ».
 *
 * Ce que ce fichier garantit, lui, c'est qu'aucune adresse distante en clair
 * n'est jamais ouverte : `toAndroidSocketUrl` refuse, et le manifeste refuse une
 * seconde fois avec `usesCleartextTraffic="false"`.
 */

/** Les quatre états d'une WebSocket, tels que la norme les numérote. */
const CONNECTING = 0;
const OPEN = 1;

/**
 * La part du `WebSocket` de la norme que ce canal utilise.
 *
 * Réduite à dessein : c'est le contrat que doit remplir l'implémentation de
 * React Native, celle de Node dans les tests, et rien de plus. Une interface
 * étroite se satisfait des deux sans adaptateur.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
}

/**
 * Fabrique de sockets.
 *
 * React Native ignore le second argument des protocoles mais accepte un objet
 * d'options en troisième position, où figurent les en-têtes. Aucun secret n'y
 * est placé : l'authentification se joue sur la signature du challenge, dans la
 * première trame. Une URL et ses en-têtes traversent tout mandataire du chemin.
 */
export type WebSocketFactory = (
  url: string,
  protocols: string[] | undefined,
  options: { headers: Record<string, string> },
) => WebSocketLike;

export interface AndroidWebSocketLinkOptions {
  /** Cœur NEXUS, par exemple `https://nexus.exemple.fr`. */
  backendUrl: string;
  /** Chemin du canal exécutant, ajouté à l'URL. */
  path?: string;
  /** Au-delà, on abandonne l'établissement ; le runtime réessaiera. */
  connectTimeoutMs?: number;
  /** Annoncé dans `user-agent`. Ne contient aucun secret. */
  userAgent?: string;
  /**
   * Taille maximale d'une trame descendante, en octets.
   *
   * Un plafond côté téléphone : un cœur compromis, ou un mandataire hostile, ne
   * doit pas pouvoir épuiser la mémoire de l'application avec une seule trame.
   * Au-delà, la trame est écartée — ce n'est plus une consigne, c'est un
   * transfert.
   */
  maxFrameBytes?: number;
  /**
   * Implémentation de `WebSocket`.
   *
   * Absente, on prend celle de l'environnement — React Native sur le téléphone,
   * Node dans les tests. L'injection existe pour les tests d'erreur, pas pour
   * offrir un transport de rechange.
   */
  socketFactory?: WebSocketFactory;
}

export class AndroidWebSocketLink implements WorkerLink {
  readonly #url: string;
  readonly #connectTimeoutMs: number;
  readonly #userAgent: string;
  readonly #maxFrameBytes: number;
  readonly #factory: WebSocketFactory;

  #socket: WebSocketLike | undefined;
  #state: LinkState = "idle";
  #onMessage: ((envelope: unknown) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  /** Vrai entre `close()` et la fermeture effective : la coupure est voulue. */
  #closing = false;

  constructor(options: AndroidWebSocketLinkOptions) {
    this.#url = toAndroidSocketUrl(options.backendUrl, options.path ?? "/ws/worker");
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.#userAgent = options.userAgent ?? "nexus-android-worker";
    this.#maxFrameBytes = options.maxFrameBytes ?? 262_144;
    this.#factory = options.socketFactory ?? defaultSocketFactory;
  }

  get state(): LinkState {
    return this.#state;
  }

  get url(): string {
    return this.#url;
  }

  connect(): Promise<void> {
    this.#state = "connecting";
    this.#closing = false;

    return new Promise<void>((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = this.#factory(this.#url, undefined, {
          headers: { "user-agent": this.#userAgent },
        });
      } catch (cause) {
        // Une fabrique qui lève — pas de `WebSocket` dans l'environnement, URL
        // rejetée par la plateforme — est un échec de connexion comme un autre :
        // le runtime réessaiera, et l'application ne s'arrête pas.
        this.#state = "closed";
        reject(cause instanceof Error ? cause : new Error(String(cause)));
        return;
      }

      this.#socket = socket;

      let settled = false;
      const once = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };

      // React Native n'applique pas de délai d'établissement : sur un réseau
      // mobile qui accepte la connexion TCP sans jamais répondre, `onopen`
      // n'arrive pas et `onerror` non plus. Sans cette minuterie, le runtime
      // attendrait indéfiniment une promesse qui ne se résout pas — et sa
      // reprise, qui est le mécanisme prévu, ne se déclencherait jamais.
      const timer = setTimeout(() => {
        once(() => {
          this.#state = "closed";
          this.#drop("délai d'établissement dépassé");
          reject(new Error("délai d'établissement dépassé"));
        });
      }, this.#connectTimeoutMs);

      socket.addEventListener("open", () => {
        once(() => {
          this.#state = "open";
          resolve();
        });
      });

      socket.addEventListener("message", (event) => {
        this.#receive(event.data);
      });

      socket.addEventListener("error", () => {
        // La norme ne transporte aucun détail dans l'événement d'erreur — pas de
        // cause, pas de code. Ce silence est celui de la plateforme, pas une
        // perte d'information de notre part.
        once(() => {
          this.#state = "closed";
          reject(new Error("connexion impossible"));
        });
      });

      socket.addEventListener("close", (event) => {
        const texte = event.reason ?? "";
        const description = texte.length > 0 ? texte : `code ${String(event.code ?? 1006)}`;

        this.#state = "closed";

        // Fermeture avant l'ouverture : c'est un refus, et `connect()` doit le
        // dire. Après : la promesse est déjà tenue et seul `onClose` compte.
        once(() => {
          reject(new Error(`connexion refusée (${description})`));
        });

        // Une fermeture que nous avons demandée n'est pas une coupure : la
        // signaler relancerait la reprise juste après un arrêt volontaire.
        if (!this.#closing) this.#onClose?.(description);
      });
    });
  }

  send(envelope: Envelope): Promise<void> {
    const socket = this.#socket;
    if (socket?.readyState !== OPEN) {
      return Promise.reject(new Error("canal fermé"));
    }

    // `send` de la norme ne rend rien et ne rappelle pas : il met en file. Une
    // promesse tenue ici signifie « remis à la pile réseau », pas « reçu par le
    // cœur ». L'accusé de réception applicatif, lui, est dans le protocole.
    try {
      socket.send(JSON.stringify(envelope));
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  close(reason: string): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();

    this.#closing = true;
    this.#state = "closed";
    this.#drop(reason);
    return Promise.resolve();
  }

  onMessage(handler: (envelope: unknown) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.#onClose = handler;
  }

  /** Ferme la socket sans toucher à l'état ; 1000 = fermeture normale. */
  #drop(reason: string): void {
    const socket = this.#socket;
    if (socket === undefined) return;
    if (socket.readyState !== OPEN && socket.readyState !== CONNECTING) return;

    try {
      // Le protocole tronque la raison à 123 octets ; certaines piles lèvent
      // au-delà plutôt que de couper.
      socket.close(1000, reason.slice(0, 100));
    } catch {
      // Fermer une socket déjà morte n'est pas une erreur qui nous concerne.
    }
  }

  /**
   * Une trame descendante.
   *
   * Ce qui n'est pas du texte est écarté : le protocole NEXUS est en JSON, et
   * accepter du binaire ouvrirait un second cadrage sans que rien ne le lise.
   * Une trame illisible ne ferme pas le canal — la suite du flux est peut-être
   * parfaitement valide, et le runtime sait déjà ignorer ce qu'il ne comprend
   * pas.
   */
  #receive(data: unknown): void {
    if (typeof data !== "string") return;
    if (data.length > this.#maxFrameBytes) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    this.#onMessage?.(parsed);
  }
}

/** Prend le `WebSocket` de l'environnement — React Native, ou Node en test. */
const defaultSocketFactory: WebSocketFactory = (url, protocols, options) => {
  const implementation = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof implementation !== "function") {
    throw new Error("aucune implémentation de WebSocket dans cet environnement");
  }

  const Constructor = implementation as new (
    url: string,
    protocols?: string[],
    options?: { headers: Record<string, string> },
  ) => WebSocketLike;

  // Le `WebSocket` de Node ignore le troisième argument ; celui de React Native
  // y lit les en-têtes. Le passer dans les deux cas évite une branche par
  // plateforme dans du code qui n'a aucun moyen de tester laquelle il sert.
  return protocols === undefined
    ? new Constructor(url, undefined, options)
    : new Constructor(url, protocols, options);
};

/**
 * Construit l'URL du canal.
 *
 * `https` devient `wss`, `http` devient `ws`. Une adresse **distante en clair
 * est refusée** : un téléphone se connecte depuis n'importe quel réseau — un
 * point d'accès public, un partage de connexion — et le jeton de session ne peut
 * pas y transiter en clair.
 *
 * `10.0.2.2` est tolérée en plus de `localhost` : c'est l'adresse de la machine
 * de développement vue depuis l'émulateur Android, et elle n'est routable depuis
 * aucun réseau. La même exception figure dans `loadAndroidConfig` et dans
 * `network_security_config.xml` — trois endroits, une seule règle.
 */
export function toAndroidSocketUrl(backendUrl: string, path: string): string {
  let url: URL;
  try {
    url = new URL(backendUrl);
  } catch {
    throw new WorkerConfigurationError([`NEXUS_BACKEND_URL : « ${backendUrl} » n'est pas une URL`]);
  }

  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "10.0.2.2";
  const clair = url.protocol === "http:" || url.protocol === "ws:";

  if (clair && !local) {
    throw new WorkerConfigurationError([
      "NEXUS_BACKEND_URL : une adresse distante doit utiliser wss:// ou https://",
    ]);
  }

  if (!clair && url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new WorkerConfigurationError([
      `NEXUS_BACKEND_URL : protocole « ${url.protocol} » non pris en charge`,
    ]);
  }

  const scheme = clair ? "ws:" : "wss:";
  const base = `${scheme}//${url.host}${url.pathname.replace(/\/$/, "")}`;

  // Le chemin est déjà présent quand l'URL configurée le porte : le fichier
  // d'exemple donne `wss://nexus.exemple.fr/ws/worker`, et l'ajouter une seconde
  // fois donnerait `/ws/worker/ws/worker`.
  return base.endsWith(path) ? base : `${base}${path}`;
}

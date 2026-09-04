import { readFile } from "node:fs/promises";
import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import { WorkerConfigurationError, type CredentialSigner } from "@nexus/worker-core";
import type { Envelope } from "@nexus/protocol";
import type { LinkState, WorkerLink } from "@nexus/worker-core";

/**
 * Raccordement de l'hôte au cœur : WebSocket sortante et signature du défi.
 *
 * ## Pourquoi un adaptateur propre à ce service
 *
 * `WorkerLink` et `CredentialSigner` sont des **ports** de `@nexus/worker-core`,
 * et c'est là que vit tout ce qui compte : poignée de main, enregistrement des
 * capacités, battements, exécution, annulation, reprise avec attente
 * exponentielle. Rien de cela n'est redit ici.
 *
 * Ce qui change d'un exécutant à l'autre, c'est l'implémentation du transport,
 * et elle change réellement : le worker Windows utilise `ws` avec épinglage TLS,
 * le worker Android utilise le `WebSocket` de React Native adossé à OkHttp.
 * Celui-ci tourne sur Node, aux côtés du cœur, et utilise le `WebSocket` de la
 * norme — présent nativement depuis Node 22, donc **sans dépendance
 * supplémentaire**.
 *
 * C'est le motif déjà établi par les phases 7 et 8 : un port partagé, un
 * adaptateur par plateforme.
 *
 * ## Ce que ce fichier garantit
 *
 * La connexion est **sortante et rien d'autre**. Il y a `connect()`, il n'y a
 * pas `listen()` : cet hôte n'écoute sur aucun port et n'accepte aucune
 * connexion entrante. Un service qui pilote un navigateur visitant du contenu
 * hostile n'a aucune raison d'être joignable.
 */

const OPEN = 1;
const CONNECTING = 0;

/** La part du `WebSocket` de la norme que ce canal utilise. */
interface StandardWebSocket {
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

export type WebSocketFactory = (url: string) => StandardWebSocket;

export interface CoreLinkOptions {
  /** Cœur NEXUS, par exemple `https://nexus.exemple.fr`. */
  backendUrl: string;
  path?: string;
  connectTimeoutMs?: number;
  /**
   * Plafond d'une trame descendante, en octets.
   *
   * Un cœur compromis ne doit pas pouvoir épuiser la mémoire de ce processus
   * avec une seule trame. Au-delà, la trame est écartée.
   */
  maxFrameBytes?: number;
  /** Injectée par les tests. En service, le `WebSocket` de l'environnement. */
  socketFactory?: WebSocketFactory;
}

export class CoreLink implements WorkerLink {
  readonly #url: string;
  readonly #connectTimeoutMs: number;
  readonly #maxFrameBytes: number;
  readonly #factory: WebSocketFactory;

  #socket: StandardWebSocket | undefined;
  #state: LinkState = "idle";
  #onMessage: ((envelope: unknown) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  /** Vrai entre `close()` et la fermeture effective : la coupure est voulue. */
  #closing = false;

  constructor(options: CoreLinkOptions) {
    this.#url = toSocketUrl(options.backendUrl, options.path ?? "/ws/worker");
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.#maxFrameBytes = options.maxFrameBytes ?? 262_144;
    this.#factory = options.socketFactory ?? defaultFactory;
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
      let socket: StandardWebSocket;
      try {
        socket = this.#factory(this.#url);
      } catch (cause) {
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

      // Sans échéance, un cœur qui accepte la connexion TCP sans jamais
      // répondre laisserait la promesse en suspens — et la reprise du runtime,
      // qui est le mécanisme prévu, ne partirait jamais.
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
        // La norme ne transporte aucun détail dans l'événement d'erreur. Ce
        // silence est celui de la plateforme, pas une perte de notre part.
        once(() => {
          this.#state = "closed";
          reject(new Error("connexion impossible"));
        });
      });

      socket.addEventListener("close", (event) => {
        const texte = event.reason ?? "";
        const description = texte.length > 0 ? texte : `code ${String(event.code ?? 1006)}`;

        this.#state = "closed";
        once(() => {
          reject(new Error(`connexion refusée (${description})`));
        });

        // Une fermeture demandée n'est pas une coupure : la signaler
        // relancerait la reprise juste après un arrêt volontaire.
        if (!this.#closing) this.#onClose?.(description);
      });
    });
  }

  send(envelope: Envelope): Promise<void> {
    const socket = this.#socket;
    if (socket?.readyState !== OPEN) {
      return Promise.reject(new Error("canal fermé"));
    }

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
   * accepter du binaire ouvrirait un second cadrage que rien ne valide. Une
   * trame illisible ne ferme pas le canal — le runtime sait déjà ignorer ce
   * qu'il ne comprend pas.
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

const defaultFactory: WebSocketFactory = (url) => {
  const implementation = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof implementation !== "function") {
    throw new Error("aucune implémentation de WebSocket : Node 22 ou plus récent est requis");
  }
  const Constructor = implementation as new (url: string) => StandardWebSocket;
  return new Constructor(url);
};

/**
 * Construit l'URL du canal.
 *
 * `https` devient `wss`, `http` devient `ws`. Une adresse **distante en clair
 * est refusée** : le défi signé ne protège que la poignée de main, et un canal
 * en clair laisserait lire — et modifier — les consignes d'exécution.
 */
export function toSocketUrl(backendUrl: string, path: string): string {
  let url: URL;
  try {
    url = new URL(backendUrl);
  } catch {
    throw new WorkerConfigurationError([`NEXUS_BACKEND_URL : « ${backendUrl} » n'est pas une URL`]);
  }

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
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
  return base.endsWith(path) ? base : `${base}${path}`;
}

/**
 * Signataire lisant une clé Ed25519 au format PEM depuis un fichier.
 *
 * La clé est lue **à chaque signature**, pas mise en cache. Une signature a lieu
 * à la connexion et à la rotation, soit quelques fois par heure : le coût est
 * nul, et le bénéfice réel — la clé ne reste pas indéfiniment dans la mémoire
 * d'un processus de longue durée, où un vidage de mémoire la trouverait.
 */
export class FileCredentialSigner implements CredentialSigner {
  readonly #path: string;

  constructor(privateKeyPath: string) {
    this.#path = privateKeyPath;
  }

  async sign(nonce: string): Promise<string> {
    let pem: string;
    try {
      pem = await readFile(this.#path, "utf8");
    } catch (cause) {
      // Le chemin ne figure jamais dans le message : il désigne un secret.
      throw new WorkerConfigurationError([
        `clé privée illisible (${cause instanceof Error ? cause.message : "erreur inconnue"})`,
      ]);
    }

    try {
      const key = createPrivateKey(pem);
      return signEd25519(null, Buffer.from(nonce, "utf8"), key).toString("base64");
    } catch {
      throw new WorkerConfigurationError(["la clé privée n'est pas une clé Ed25519 au format PEM"]);
    }
  }
}

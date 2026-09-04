import tls from "node:tls";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import type { Envelope } from "@nexus/protocol";
import type { LinkState, WorkerLink } from "@nexus/worker-core";
import { WorkerConfigurationError } from "../errors.js";

/**
 * Le canal réel vers le cœur : une WebSocket **sortante**.
 *
 * Sortante, et rien d'autre. Ce module ouvre une connexion ; il n'écoute sur
 * aucun port, n'accepte aucune connexion entrante, et n'expose aucun service.
 * Le poste peut donc vivre derrière un routeur domestique sans redirection de
 * port, sans règle de pare-feu entrante, sans être joignable depuis Internet —
 * ce qui supprime d'un coup toute la surface d'attaque d'un démon exposé.
 *
 * Cette forme est déjà inscrite dans le port `WorkerLink` : il y a `connect()`,
 * il n'y a pas `listen()`. Ce fichier ne fait que l'honorer avec `ws`.
 *
 * Tout le reste — poignée de main, signature du challenge, enregistrement des
 * capacités, battements, exécution, reprise avec attente exponentielle — vit
 * dans `WorkerRuntime` et n'a pas à être redit ici.
 */

export interface WebSocketLinkOptions {
  /** URL du cœur, par exemple `https://nexus.exemple.fr`. */
  backendUrl: string;
  /** Ajouté à l'URL. Le chemin du canal exécutant. */
  path?: string;
  /** Délai d'établissement. Au-delà, on abandonne et le runtime réessaiera. */
  connectTimeoutMs?: number;
  /**
   * Version du worker, annoncée dans l'en-tête `user-agent`.
   *
   * Aucun secret n'y figure : l'authentification se joue sur la signature du
   * challenge, dans la première trame, jamais dans un en-tête ni dans l'URL. Une
   * URL de WebSocket apparaît dans les journaux de tout proxy sur le chemin.
   */
  userAgent?: string;
  /**
   * Empreinte SHA-256 de la clé publique du certificat du cœur, en base64.
   *
   * **Vérification de l'identité du cœur.** Sans elle, l'identité repose sur la
   * chaîne de certification : n'importe quelle autorité reconnue par la machine
   * — y compris celle qu'un proxy d'entreprise ou un logiciel de sécurité y a
   * installée — peut se faire passer pour le cœur, et commander l'exécutant.
   *
   * Avec elle, seul le certificat attendu est accepté. Ce worker ne parle qu'à
   * un seul serveur : épingler sa clé est le contrôle adéquat, et il ne coûte
   * qu'une ligne de configuration.
   *
   * Absente = comportement par défaut de Node, c'est-à-dire validation par les
   * autorités du système. C'est le repli, pas l'idéal.
   */
  corePublicKeyFingerprint?: string;
}

export class WebSocketLink implements WorkerLink {
  readonly #url: string;
  readonly #connectTimeoutMs: number;
  readonly #userAgent: string;
  readonly #fingerprint: string | undefined;

  #socket: WebSocket | undefined;
  #state: LinkState = "idle";
  #onMessage: ((envelope: unknown) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;

  constructor(options: WebSocketLinkOptions) {
    this.#url = toSocketUrl(options.backendUrl, options.path ?? "/ws/worker");
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.#userAgent = options.userAgent ?? "nexus-windows-worker";
    this.#fingerprint = options.corePublicKeyFingerprint;
  }

  get state(): LinkState {
    return this.#state;
  }

  get url(): string {
    return this.#url;
  }

  connect(): Promise<void> {
    this.#state = "connecting";

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#url, {
        headers: { "user-agent": this.#userAgent },
        handshakeTimeout: this.#connectTimeoutMs,
        // L'épinglage s'ajoute à la validation par autorité, il ne la remplace
        // pas : `rejectUnauthorized` reste vrai (défaut de Node), et le
        // certificat doit *en plus* être celui qu'on attend.
        ...(this.#fingerprint === undefined
          ? {}
          : { checkServerIdentity: pinnedIdentity(this.#fingerprint) }),
        // 256 Ko : au-delà, ce n'est plus une consigne, c'est un transfert. Un
        // plafond côté client évite qu'un cœur compromis n'épuise la mémoire de
        // la machine avec une seule trame.
        maxPayload: 262_144,
      });

      this.#socket = socket;

      let regle = false;
      const une = (action: () => void) => {
        if (regle) return;
        regle = true;
        action();
      };

      socket.on("open", () => {
        une(() => {
          this.#state = "open";
          resolve();
        });
      });

      socket.on("message", (data) => {
        // Une trame illisible est ignorée : la suite du flux est peut-être
        // parfaitement valide, et le runtime sait déjà écarter ce qu'il ne
        // comprend pas.
        try {
          this.#onMessage?.(JSON.parse(decodeFrame(data)));
        } catch {
          return;
        }
      });

      socket.on("error", (cause) => {
        une(() => {
          this.#state = "closed";
          reject(cause);
        });
      });

      socket.on("close", (code, raison) => {
        const texte = raison.toString("utf8");
        const description = texte.length > 0 ? texte : `code ${String(code)}`;

        this.#state = "closed";

        // Fermeture avant l'ouverture : c'est un refus, et `connect()` doit le
        // dire. Fermeture après : la promesse est déjà tenue, `une` n'y touche
        // pas, et seul `onClose` compte.
        une(() => {
          reject(new Error(`connexion refusée (${description})`));
        });

        // La reprise appartient au runtime : il tient l'attente exponentielle et
        // sait ce qu'il faut rejouer. Le canal se contente de signaler.
        this.#onClose?.(description);
      });
    });
  }

  send(envelope: Envelope): Promise<void> {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("canal fermé"));
    }

    return new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(envelope), (cause) => {
        if (cause == null) resolve();
        else reject(cause);
      });
    });
  }

  close(reason: string): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();

    this.#state = "closed";
    // 1000 : fermeture normale. La raison est tronquée à 123 octets par le
    // protocole ; `ws` lèverait au-delà.
    this.#socket?.close(1000, reason.slice(0, 100));
    return Promise.resolve();
  }

  onMessage(handler: (envelope: unknown) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.#onClose = handler;
  }
}

/**
 * Décode une trame entrante en texte.
 *
 * `ws` rend un `Buffer`, un `ArrayBuffer` ou un tableau de `Buffer` selon la
 * fragmentation — `String(data)` sur les deux derniers donnerait
 * `[object ArrayBuffer]`, une chaîne d'apparence valide qui échouerait ensuite à
 * l'analyse JSON sans dire pourquoi.
 */
function decodeFrame(data: Buffer | ArrayBuffer | readonly Buffer[]): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

/**
 * Contrôle d'identité épinglé.
 *
 * Rend une fonction que `ws` appelle après la validation TLS ordinaire. Elle
 * compare l'empreinte SHA-256 de la **clé publique** du certificat présenté à
 * celle attendue.
 *
 * La clé publique et non le certificat entier : un renouvellement de certificat
 * conserve la clé, et épingler le certificat obligerait à reconfigurer chaque
 * machine tous les trois mois — une contrainte qu'on finit par désactiver.
 */
function pinnedIdentity(expected: string) {
  return (hostname: string, certificate: { pubkey?: Buffer }): Error | undefined => {
    const authorised = tls.checkServerIdentity(hostname, certificate as never);
    if (authorised !== undefined) return authorised;

    const pubkey = certificate.pubkey;
    if (pubkey === undefined) {
      return new Error("certificat sans clé publique exploitable");
    }

    const actual = createHash("sha256").update(pubkey).digest("base64");

    // Comparaison en temps constant : l'empreinte n'est pas un secret, mais la
    // comparer paresseusement est une habitude qu'on ne veut pas prendre.
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);

    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return new Error("empreinte de clé publique du cœur inattendue");
    }

    return undefined;
  };
}

/**
 * Construit l'URL du canal.
 *
 * `https` devient `wss`, `http` devient `ws`. Une adresse distante en clair est
 * **refusée** : le challenge signé ne protège pas ce qui suit, et un canal en
 * clair laisserait lire — et modifier — les consignes d'exécution envoyées à
 * cette machine.
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

  const scheme = clair ? "ws:" : "wss:";
  const base = `${scheme}//${url.host}${url.pathname.replace(/\/$/, "")}`;

  return `${base}${path}`;
}

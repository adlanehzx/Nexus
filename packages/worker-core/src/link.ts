import type { Envelope } from "@nexus/protocol";

/**
 * Canal vers le cœur.
 *
 * **Port, pas implémentation.** Le worker ne connaît pas le WebSocket ; il
 * connaît une chose capable d'ouvrir un canal, d'envoyer des enveloppes et d'en
 * recevoir. Trois conséquences :
 *
 *  1. tout le worker — authentification, enregistrement, exécution, reprise —
 *     se teste sans réseau ;
 *  2. le WebSocket réel de la phase suivante s'y branche sans modifier une ligne
 *     de logique ;
 *  3. le sens de la connexion est inscrit dans la forme du port : il y a
 *     `connect()`, il n'y a pas `listen()`. Ce worker ne peut structurellement
 *     pas accepter de connexion entrante.
 */

export type LinkState = "idle" | "connecting" | "open" | "closed";

export interface WorkerLink {
  readonly state: LinkState;
  connect(): Promise<void>;
  send(envelope: Envelope): Promise<void>;
  close(reason: string): Promise<void>;
  onMessage(handler: (envelope: unknown) => void): void;
  /** Fermeture subie ou demandée. Le worker y déclenche sa reconnexion. */
  onClose(handler: (reason: string) => void): void;
}

/**
 * Canal de bout en bout, en mémoire.
 *
 * Sert aux tests d'intégration : il relie le worker à un vrai `WorkerGateway`
 * sans passer par le réseau, ce qui permet de valider le chemin complet
 * `TaskCoordinator → WorkerTransport → worker → capacité → événements`.
 *
 * Ce n'est pas un simulacre du protocole : les deux extrémités échangent les
 * mêmes enveloppes que sur le fil, validées par les mêmes schémas.
 */
export class LoopbackLink implements WorkerLink {
  #state: LinkState = "idle";
  #onMessage: ((envelope: unknown) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;

  /** Réception côté cœur. Branché par le harnais de test sur la passerelle. */
  outbound: (envelope: Envelope) => Promise<void> | void = () => undefined;
  /** Échoue le prochain `connect()`, pour éprouver la reprise. */
  failNextConnect = false;

  readonly sent: Envelope[] = [];

  get state(): LinkState {
    return this.#state;
  }

  connect(): Promise<void> {
    this.#state = "connecting";
    if (this.failNextConnect) {
      this.failNextConnect = false;
      this.#state = "closed";
      return Promise.reject(new Error("connexion refusée"));
    }
    this.#state = "open";
    return Promise.resolve();
  }

  async send(envelope: Envelope): Promise<void> {
    if (this.#state !== "open") throw new Error("canal fermé");
    this.sent.push(envelope);
    await this.outbound(envelope);
  }

  /** Livre une trame descendante au worker. */
  deliver(envelope: unknown): void {
    this.#onMessage?.(envelope);
  }

  close(reason: string): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();
    this.#state = "closed";
    this.#onClose?.(reason);
    return Promise.resolve();
  }

  /** Coupure subie, à l'initiative de l'autre bout ou du réseau. */
  drop(reason: string): void {
    void this.close(reason);
  }

  onMessage(handler: (envelope: unknown) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.#onClose = handler;
  }
}

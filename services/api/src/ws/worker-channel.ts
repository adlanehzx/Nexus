import type { Envelope } from "@nexus/protocol";
import type { WorkerConnection } from "@nexus/devices";
import type { ServiceContainer } from "../services/container.js";

/**
 * Canal temps réel des exécutants.
 *
 * Volontairement mince : **toute la logique est déjà dans `WorkerGateway`**, qui
 * l'expose derrière un point d'entrée unique, `handleMessage`. Ce module ne fait
 * que relier une socket à ce point d'entrée et gérer la fermeture.
 *
 * Deux propriétés que ce découpage garantit :
 *
 *  - un worker n'atteint **jamais** le canal client, et réciproquement. Les deux
 *    canaux ont des points d'entrée, des schémas et des types disjoints ; un
 *    `worker.task_result` forgé depuis un téléphone n'a nulle part où arriver ;
 *  - la logique de la passerelle est testée sans réseau, et le reste. Ce fichier
 *    ne contient aucune décision qu'il faudrait éprouver à nouveau ici.
 */

export interface WorkerSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  remoteAddress?: string;
}

export interface WorkerChannelOptions {
  services: ServiceContainer;
  onError?: (error: unknown, deviceId: string) => void;
}

/**
 * Une connexion worker en cours d'établissement.
 *
 * `deviceId` est renseigné dès le `worker.hello` — **il n'authentifie rien**. Il
 * sert uniquement à router les réponses de la poignée de main vers la bonne
 * socket. L'authentification, elle, se joue sur la signature du challenge, et
 * c'est `DeviceSessionService` qui la vérifie.
 */
interface AttachedWorker {
  socket: WorkerSocket;
  deviceId: string;
}

export class WorkerChannel {
  readonly #services: ServiceContainer;
  readonly #onError: WorkerChannelOptions["onError"];

  readonly #attached = new Map<string, AttachedWorker>();

  constructor(options: WorkerChannelOptions) {
    this.#services = options.services;
    this.#onError = options.onError;
  }

  get attachedCount(): number {
    return this.#attached.size;
  }

  /**
   * Cette socket a-t-elle prouvé son identité ?
   *
   * La réponse ne vient pas d'un drapeau local : elle vient de la passerelle,
   * seule à savoir si le challenge a été signé. Un booléen tenu ici pourrait
   * dériver de la vérité, et un transport qui croit une machine authentifiée
   * alors qu'elle ne l'est pas est exactement le bogue qu'on ne veut pas.
   */
  isAuthenticated(connectionId: string): boolean {
    // La réponse vient de la passerelle, seule à savoir si le challenge a été
    // signé — et elle répond **pour cette socket**, pas pour l'appareil. Deux
    // sockets peuvent prétendre au même appareil ; une seule a signé.
    return this.#services.gateway.authenticatedDeviceId(connectionId) !== undefined;
  }

  /**
   * Ouvre un canal pour une socket qui vient d'arriver.
   *
   * `connectionId` identifie la socket, pas l'appareil : deux sockets peuvent
   * prétendre au même `deviceId` avant authentification, et les confondre
   * permettrait à l'une de recevoir les trames de l'autre.
   */
  open(connectionId: string, socket: WorkerSocket): void {
    this.#attached.set(connectionId, { socket, deviceId: "" });
  }

  /**
   * Traite une trame montante d'un exécutant.
   *
   * Tout passe par `WorkerGateway.handleMessage` : hello, authentification,
   * enregistrement de capacités, battements, progression et résultats. Ce module
   * n'interprète rien.
   */
  async handle(connectionId: string, raw: unknown): Promise<void> {
    const attached = this.#attached.get(connectionId);
    if (attached === undefined) return;

    // Le `deviceId` annoncé sert à adresser les réponses. La passerelle ne lui
    // accorde aucune confiance : elle exige une signature avant d'ouvrir quoi
    // que ce soit.
    const announced = declaredDeviceId(raw);
    if (announced !== undefined && attached.deviceId === "") {
      attached.deviceId = announced;
    }

    const connection: WorkerConnection = {
      connectionId,
      // Annoncé par le pair. La passerelle ne s'en sert que pour adresser la
      // réponse au challenge ; elle ne lui accorde aucune autorité.
      deviceId: attached.deviceId,
      send: (envelope: Envelope) => {
        attached.socket.send(JSON.stringify(envelope));
      },
      close: (code, reason) => {
        attached.socket.close(code, reason);
      },
      ...(attached.socket.remoteAddress === undefined
        ? {}
        : { remoteAddress: attached.socket.remoteAddress }),
    };

    try {
      await this.#services.gateway.handleMessage(connection, raw);
    } catch (cause) {
      // Une trame refusée — signature invalide, appareil révoqué, rejeu — ferme
      // la connexion. Un exécutant qui présente un mauvais secret n'a rien à
      // faire sur ce canal, et le laisser réessayer en boucle sur la même socket
      // transformerait le refus en simple ralentissement.
      this.#onError?.(cause, attached.deviceId);
      attached.socket.close(4401, "authentification refusée");
      await this.close(connectionId, "authentification refusée");
    }
  }

  /**
   * Ferme un canal.
   *
   * Le détachement côté passerelle est ce qui libère les étapes en vol : sans
   * lui, le coordinateur attendrait leur délai complet avant de comprendre que
   * la machine a disparu, alors qu'il peut les reprendre ailleurs tout de suite.
   */
  async close(connectionId: string, reason: string): Promise<void> {
    const attached = this.#attached.get(connectionId);
    if (attached === undefined) return;

    this.#attached.delete(connectionId);

    // Détachement **par connexion**, jamais par identifiant annoncé : une socket
    // qui s'est contentée de dire un identifiant public ne doit pas pouvoir
    // mettre l'appareil correspondant hors ligne en raccrochant.
    await this.#services.gateway.detachConnection(connectionId, reason);
  }
}

/**
 * Extrait le `deviceId` d'une trame de poignée de main.
 *
 * Sans validation : c'est volontaire, la passerelle valide. Ici on cherche
 * seulement à savoir où renvoyer le challenge.
 */
function declaredDeviceId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;

  const payload = (raw as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object") return undefined;

  const deviceId = (payload as { deviceId?: unknown }).deviceId;
  return typeof deviceId === "string" && deviceId.length > 0 ? deviceId : undefined;
}

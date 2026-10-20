import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, uuidv7 } from "@nexus/shared";

/**
 * Appairage d'un appareil par ticket à usage unique.
 *
 * ## Ce que ça remplace, et ce que ça ne remplace pas
 *
 * La clé privée d'un téléphone naît dans son magasin de clés et n'en sort
 * jamais. Le cœur doit donc recevoir la **clé publique**, et quelqu'un doit la
 * lui porter. Jusqu'ici, ce transport se faisait à la main : lire la clé sur le
 * téléphone, la coller dans le tableau de bord. C'est long, et une clé recopiée
 * de travers produit un appareil qui s'enregistre puis échoue à chaque poignée
 * de main, sans que rien ne nomme la cause.
 *
 * Le ticket remplace ce **transport**. Il ne remplace pas la preuve.
 *
 * ## Pourquoi un ticket prouve quelque chose
 *
 * Le ticket est émis par une surface **déjà authentifiée** et s'affiche sur
 * l'écran du propriétaire. Le scanner demande de voir cet écran : c'est une
 * preuve de présence physique, exactement comme la recopie manuelle, mais sans
 * la recopie. Il porte l'identité du propriétaire, donc l'appareil créé ne peut
 * appartenir à personne d'autre — le scanneur ne choisit pas son propriétaire.
 *
 * Trois propriétés rendent cette preuve étroite :
 *
 *  1. **usage unique** — un QR photographié par-dessus l'épaule ne sert plus
 *     une fois l'appareil appairé ;
 *  2. **courte durée** — cinq minutes par défaut, soit très au-delà du geste
 *     et très en deçà d'une fenêtre exploitable ;
 *  3. **jamais stocké en clair** — seule l'empreinte SHA-256 est conservée. Une
 *     base lue par un tiers ne donne aucun ticket utilisable.
 *
 * ## Ce que le ticket ne donne pas
 *
 * L'appareil créé arrive `PENDING` et hors ligne, comme n'importe quel appareil
 * enregistré à la main. Le ticket porte la preuve d'un transport, pas une
 * décision de confiance : approuver reste un geste distinct, et c'est lui qui
 * ouvre la première session. Confondre les deux économiserait un clic et
 * supprimerait le seul endroit où le propriétaire voit *ce* qu'il approuve.
 */

/** Durée de vie par défaut d'un ticket. */
export const PAIRING_TICKET_TTL_MS = 5 * 60_000;

/** Longueur du secret, en octets, avant encodage. */
const CODE_BYTES = 32;

export interface PairingTicket {
  id: string;
  userId: string;
  /**
   * Empreinte SHA-256 du code, en hexadécimal.
   *
   * Le code en clair ne vit que le temps de la réponse qui l'a produit. On
   * cherche donc *par empreinte* au lieu de comparer : il n'y a pas de
   * comparaison à rendre constante, et aucune base à relire pour retrouver un
   * secret.
   */
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  /** Appareil créé par ce ticket. Renseigné à la consommation. */
  deviceId: string | null;
  /** Étiquette libre, pour que l'écran de gestion dise quel QR est lequel. */
  label: string | null;
}

/**
 * Vue publiable d'un ticket.
 *
 * Volontairement sans empreinte : un écran de gestion n'a aucune raison de
 * l'afficher, et un type qui ne la porte pas ne peut pas la laisser fuir.
 */
export interface PairingTicketSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  deviceId: string | null;
  label: string | null;
  status: "pending" | "consumed" | "expired";
}

export interface PairingTicketStore {
  save(ticket: PairingTicket): Promise<void>;
  findByCodeHash(codeHash: string): Promise<PairingTicket | undefined>;
  listByUser(userId: string): Promise<PairingTicket[]>;
  /** Supprime les tickets périmés ou consommés avant `before`. */
  prune(before: Date): Promise<number>;
}

export class InMemoryPairingTicketStore implements PairingTicketStore {
  readonly #tickets = new Map<string, PairingTicket>();

  save(ticket: PairingTicket): Promise<void> {
    this.#tickets.set(ticket.id, structuredClone(ticket));
    return Promise.resolve();
  }

  findByCodeHash(codeHash: string): Promise<PairingTicket | undefined> {
    for (const ticket of this.#tickets.values()) {
      if (ticket.codeHash === codeHash) return Promise.resolve(structuredClone(ticket));
    }
    return Promise.resolve(undefined);
  }

  listByUser(userId: string): Promise<PairingTicket[]> {
    return Promise.resolve(
      [...this.#tickets.values()]
        .filter((ticket) => ticket.userId === userId)
        .map((ticket) => structuredClone(ticket)),
    );
  }

  prune(before: Date): Promise<number> {
    let removed = 0;
    for (const [id, ticket] of this.#tickets) {
      const done = ticket.consumedAt !== null || ticket.expiresAt.getTime() <= before.getTime();
      if (done && ticket.createdAt.getTime() <= before.getTime()) {
        this.#tickets.delete(id);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  get size(): number {
    return this.#tickets.size;
  }
}

export class PairingTicketInvalidError extends AppError {
  readonly code = "PAIRING_TICKET_INVALID";
  readonly httpStatus = 401;

  /**
   * Le motif reste dans le contexte, jamais dans le message affiché.
   *
   * « Ticket expiré » et « ticket inconnu » renseignent qui en essaie un au
   * hasard : la première réponse lui apprend qu'il a touché un vrai ticket. Le
   * propriétaire, lui, voit la même phrase utile dans les deux cas — son geste
   * est le même, régénérer le QR.
   */
  constructor(reason: "unknown" | "expired" | "consumed") {
    super({
      message: `Ticket d'appairage refusé : ${reason}`,
      userMessage: "Ce code d'appairage n'est plus valable. Affiche un nouveau QR et rescanne.",
      context: { reason },
    });
  }
}

export interface PairingServiceOptions {
  store: PairingTicketStore;
  ttlMs?: number;
  now?: () => Date;
  newId?: () => string;
  /** Source d'aléa, remplaçable pour les tests. */
  randomCode?: () => string;
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Code à usage unique : 32 octets d'aléa, en base64url sans remplissage. */
export function newPairingCode(): string {
  return randomBytes(CODE_BYTES).toString("base64url");
}

export interface IssuedTicket {
  ticket: PairingTicket;
  /**
   * Le code en clair.
   *
   * Rendu **une seule fois**, à l'émission. Il n'existe aucun moyen de le
   * relire : c'est ce qui rend vraie la promesse « aucun secret au repos ».
   */
  code: string;
}

export class PairingService {
  readonly #store: PairingTicketStore;
  readonly #ttlMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #randomCode: () => string;

  constructor(options: PairingServiceOptions) {
    this.#store = options.store;
    this.#ttlMs = options.ttlMs ?? PAIRING_TICKET_TTL_MS;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#randomCode = options.randomCode ?? newPairingCode;
  }

  async issue(input: { userId: string; label?: string }): Promise<IssuedTicket> {
    const createdAt = this.#now();
    const code = this.#randomCode();
    const ticket: PairingTicket = {
      id: this.#newId(),
      userId: input.userId,
      codeHash: hashPairingCode(code),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.#ttlMs),
      consumedAt: null,
      deviceId: null,
      label: input.label ?? null,
    };
    await this.#store.save(ticket);
    return { ticket, code };
  }

  /**
   * Échange un code contre l'identité de son propriétaire.
   *
   * Ne crée pas l'appareil : l'appelant le fait, puis appelle `complete`. En
   * deux temps parce qu'un seul temps obligerait ce service à connaître le
   * registre des appareils, et donc à être monté avec lui — alors qu'il n'a
   * besoin de rien d'autre que de son magasin.
   */
  async redeem(code: string): Promise<PairingTicket> {
    const ticket = await this.#store.findByCodeHash(hashPairingCode(code));
    if (ticket === undefined) throw new PairingTicketInvalidError("unknown");
    if (ticket.consumedAt !== null) throw new PairingTicketInvalidError("consumed");
    if (ticket.expiresAt.getTime() <= this.#now().getTime()) {
      throw new PairingTicketInvalidError("expired");
    }
    return ticket;
  }

  /** Marque le ticket consommé et le lie à l'appareil créé. */
  async complete(ticket: PairingTicket, deviceId: string): Promise<PairingTicket> {
    const consumed: PairingTicket = { ...ticket, consumedAt: this.#now(), deviceId };
    await this.#store.save(consumed);
    return consumed;
  }

  async list(userId: string): Promise<PairingTicketSummary[]> {
    const now = this.#now().getTime();
    const tickets = await this.#store.listByUser(userId);
    return tickets
      .map((ticket) => ({
        id: ticket.id,
        createdAt: ticket.createdAt,
        expiresAt: ticket.expiresAt,
        consumedAt: ticket.consumedAt,
        deviceId: ticket.deviceId,
        label: ticket.label,
        status:
          ticket.consumedAt !== null
            ? ("consumed" as const)
            : ticket.expiresAt.getTime() <= now
              ? ("expired" as const)
              : ("pending" as const),
      }))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  prune(): Promise<number> {
    return this.#store.prune(this.#now());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Charge utile du QR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schéma propre plutôt qu'une URL `https://`.
 *
 * Un code dans une URL web finit dans un historique, un journal de proxy, un
 * presse-papiers partagé. `nexus://` n'est pas ouvrable par un navigateur : si
 * la charge utile sort du chemin prévu, elle n'atteint rien.
 */
export const PAIRING_URI_SCHEME = "nexus";

export interface PairingPayload {
  /** Base de l'API que l'appareil devra appeler. */
  apiUrl: string;
  /**
   * Le code à usage unique.
   *
   * Nommé `token` jusque dans la charge utile, et c'est volontaire : la
   * rédaction de `@nexus/shared` masque par **nom de clé**, et `token` en fait
   * partie. Un champ nommé `code` traverserait les journaux en clair.
   */
  token: string;
}

export function encodePairingPayload(payload: PairingPayload): string {
  const url = new URL(`${PAIRING_URI_SCHEME}://pair`);
  url.searchParams.set("api", payload.apiUrl);
  url.searchParams.set("token", payload.token);
  return url.toString();
}

export function decodePairingPayload(text: string): PairingPayload {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch (error) {
    throw new PairingPayloadError("charge utile illisible", { cause: error });
  }
  if (url.protocol !== `${PAIRING_URI_SCHEME}:` || url.host !== "pair") {
    throw new PairingPayloadError("ce QR n'est pas un QR d'appairage NEXUS");
  }
  const apiUrl = url.searchParams.get("api");
  const token = url.searchParams.get("token");
  if (apiUrl === null || token === null) {
    throw new PairingPayloadError("charge utile incomplète");
  }
  // L'adresse vient d'un QR : elle est une **donnée**. Un scanneur qui
  // accepterait `file://` ou un schéma exotique offrirait à un QR malveillant
  // de choisir où l'appareil enverra sa clé publique.
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch (error) {
    throw new PairingPayloadError("adresse d'API invalide", { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PairingPayloadError("adresse d'API invalide : seuls http et https sont acceptés");
  }
  return { apiUrl, token };
}

export class PairingPayloadError extends AppError {
  readonly code = "PAIRING_PAYLOAD_INVALID";
  readonly httpStatus = 400;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super({
      message,
      userMessage: "Ce QR code n'est pas utilisable pour appairer un appareil.",
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
  }
}

/**
 * Comparaison à temps constant, pour les appelants qui en ont besoin.
 *
 * Ce service n'en a pas besoin — il cherche par empreinte — mais un worker qui
 * vérifierait un code localement, lui, en aurait besoin. L'exposer ici évite
 * qu'il soit réécrit avec `===`.
 */
export function pairingCodesEqual(left: string, right: string): boolean {
  const a = Buffer.from(hashPairingCode(left), "hex");
  const b = Buffer.from(hashPairingCode(right), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

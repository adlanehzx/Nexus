import { AppError } from "@nexus/shared";

/**
 * Mode hors ligne : ce qu'on écrit sans réseau, et ce qu'on refuse d'écrire.
 *
 * ## Le piège que ce module existe pour éviter
 *
 * Une file d'attente hors ligne est une machine à doubler les actions. Le
 * téléphone envoie « range mes mails », perd le réseau avant la réponse,
 * réessaie à la reconnexion — et la demande part deux fois. Le module de
 * rattrapage porte déjà cet avertissement : « un rattrapage qui pourrait créer
 * une tâche transformerait une coupure réseau en seconde commande ».
 *
 * Trois règles en découlent, et chacune ferme une voie de doublon.
 *
 * **1. Une clé d'idempotence est obligatoire, et elle naît à la mise en file.**
 * Pas à l'envoi. C'est tout l'intérêt : les trois tentatives d'une même entrée
 * portent la même clé, donc le cœur reconnaît la répétition. Une clé générée à
 * l'envoi serait différente à chaque essai, c'est-à-dire inutile.
 *
 * **2. On ne met en file que ce que le serveur sait dédupliquer.** C'est une
 * limite réelle, et la nommer vaut mieux que l'ignorer : si une route n'honore
 * pas la clé, la mettre en file garantit le doublon au lieu de le risquer. La
 * file refuse donc, et le dit.
 *
 * **3. Une entrée expire.** Une intention dont le contexte a disparu n'est plus
 * une intention : « réponds à ce mail » mis en file mardi n'a aucun sens
 * vendredi, et l'exécuter serait pire que de l'avoir perdu.
 *
 * ## Ce qui n'entre jamais en file
 *
 * Les confirmations. Approuver hors ligne une action à risque, puis l'envoyer
 * trois heures plus tard, c'est approuver quelque chose qu'on n'a pas relu —
 * et qui a peut-être changé. Une confirmation se donne en ligne, devant ce
 * qu'elle autorise.
 */

export interface OutboxRequest {
  method: "POST" | "PATCH" | "PUT";
  path: string;
  body: unknown;
}

export interface OutboxEntry {
  id: string;
  request: OutboxRequest;
  /** Née à la mise en file. Identique à chaque tentative — c'est le principe. */
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  lastError: string | null;
}

export interface OutboxStore {
  all(): Promise<OutboxEntry[]>;
  save(entries: readonly OutboxEntry[]): Promise<void>;
}

/** Magasin en mémoire. Les clients durables fournissent le leur. */
export class InMemoryOutboxStore implements OutboxStore {
  #entries: OutboxEntry[] = [];

  all(): Promise<OutboxEntry[]> {
    return Promise.resolve(this.#entries.map((entry) => ({ ...entry })));
  }

  save(entries: readonly OutboxEntry[]): Promise<void> {
    this.#entries = entries.map((entry) => ({ ...entry }));
    return Promise.resolve();
  }
}

export class NotQueueableError extends AppError {
  readonly code = "NOT_QUEUEABLE";
  readonly httpStatus = 409;

  constructor(path: string, reason: string) {
    super({
      message: `${path} ne peut pas être mis en file : ${reason}`,
      userMessage:
        "Cette action a besoin du réseau : NEXUS ne peut pas la garder pour plus tard sans risquer de la faire deux fois.",
      context: { path, reason },
    });
  }
}

export interface OutboxOptions {
  store: OutboxStore;
  /**
   * Chemins dont le serveur honore la clé d'idempotence.
   *
   * Liste blanche et non liste noire : une route ajoutée demain n'est pas
   * mise en file par défaut. Se tromper dans ce sens coûte une action qu'il
   * faut refaire en ligne ; dans l'autre, une action faite deux fois.
   */
  idempotentPaths: readonly string[];
  now?: () => number;
  newId?: () => string;
  /** Durée de vie d'une entrée. Au-delà, le contexte a disparu. */
  ttlMs?: number;
  /** Nombre maximal d'entrées. Au-delà, les plus anciennes sont écartées. */
  capacity?: number;
}

export interface FlushOutcome {
  sent: OutboxEntry[];
  /** Restées en file : l'envoi s'est arrêté, ou elles n'ont pas encore été tentées. */
  remaining: OutboxEntry[];
  expired: OutboxEntry[];
  stoppedBy: "fin" | "échec" | "hors-ligne";
}

export type OutboxSender = (
  entry: OutboxEntry,
) => Promise<{ ok: true } | { ok: false; retryable: boolean; error: string }>;

export class Outbox {
  readonly #store: OutboxStore;
  readonly #idempotent: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #ttlMs: number;
  readonly #capacity: number;

  constructor(options: OutboxOptions) {
    this.#store = options.store;
    this.#idempotent = new Set(options.idempotentPaths);
    this.#now = options.now ?? (() => Date.now());
    this.#newId =
      options.newId ??
      (() => `out-${String(this.#now())}-${Math.random().toString(36).slice(2, 10)}`);
    // Vingt-quatre heures : assez pour traverser une nuit sans réseau, trop peu
    // pour qu'une intention devienne absurde.
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.#capacity = options.capacity ?? 100;
  }

  /** Cette requête peut-elle attendre le retour du réseau ? */
  queueable(request: OutboxRequest): { ok: boolean; reason?: string } {
    if (isConfirmation(request.path)) {
      return {
        ok: false,
        reason:
          "une confirmation se donne en ligne, devant ce qu'elle autorise — pas trois heures plus tard",
      };
    }
    if (!this.#idempotent.has(request.path)) {
      return {
        ok: false,
        reason: "le serveur ne sait pas reconnaître un envoi répété sur ce chemin",
      };
    }
    return { ok: true };
  }

  async enqueue(request: OutboxRequest): Promise<OutboxEntry> {
    const verdict = this.queueable(request);
    if (!verdict.ok) throw new NotQueueableError(request.path, verdict.reason ?? "refusé");

    const createdAt = this.#now();
    const entry: OutboxEntry = {
      id: this.#newId(),
      request,
      // La clé naît **ici**. Les tentatives suivantes la réutilisent, et c'est
      // ce qui permet au cœur de reconnaître la répétition.
      idempotencyKey: this.#newId(),
      createdAt,
      expiresAt: createdAt + this.#ttlMs,
      attempts: 0,
      lastError: null,
    };

    const existing = await this.#store.all();
    const kept = [...existing, entry]
      // Les plus anciennes partent d'abord : une file pleine doit perdre ce qui
      // a le moins de chances d'avoir encore du sens.
      .slice(-this.#capacity);
    await this.#store.save(kept);
    return entry;
  }

  async pending(): Promise<OutboxEntry[]> {
    const now = this.#now();
    return (await this.#store.all()).filter((entry) => entry.expiresAt > now);
  }

  /**
   * Envoie la file, dans l'ordre, et s'arrête au premier échec réessayable.
   *
   * L'ordre **et** l'arrêt comptent. Deux messages envoyés à l'envers racontent
   * une autre conversation ; et continuer après un échec réseau enverrait le
   * second message d'une suite dont le premier n'est pas passé.
   */
  async flush(send: OutboxSender, options: { online?: boolean } = {}): Promise<FlushOutcome> {
    const now = this.#now();
    const all = await this.#store.all();
    const expired = all.filter((entry) => entry.expiresAt <= now);
    let queue = all.filter((entry) => entry.expiresAt > now);

    if (options.online === false) {
      // Rien ne part hors ligne : une tentative sans réseau ne fait que
      // consommer un essai et brouiller le compte.
      await this.#store.save(queue);
      return { sent: [], remaining: queue, expired, stoppedBy: "hors-ligne" };
    }

    const sent: OutboxEntry[] = [];
    let stoppedBy: FlushOutcome["stoppedBy"] = "fin";

    while (queue.length > 0) {
      const entry = queue[0];
      if (entry === undefined) break;
      const attempted: OutboxEntry = { ...entry, attempts: entry.attempts + 1 };
      const result = await send(attempted);

      if (result.ok) {
        sent.push(attempted);
        queue = queue.slice(1);
        continue;
      }
      if (!result.retryable) {
        // Un refus définitif — requête invalide, droit manquant — ne sera pas
        // meilleur demain. La garder bloquerait toute la file derrière elle.
        queue = queue.slice(1);
        continue;
      }
      queue = [{ ...attempted, lastError: result.error }, ...queue.slice(1)];
      stoppedBy = "échec";
      break;
    }

    await this.#store.save(queue);
    return { sent, remaining: queue, expired, stoppedBy };
  }

  /** Vide la file. Utilisé à la déconnexion : la file appartient à une session. */
  async clear(): Promise<void> {
    await this.#store.save([]);
  }
}

function isConfirmation(path: string): boolean {
  return /\/confirmations?\//.test(path) || path.endsWith("/confirmation");
}

/**
 * Contexte court terme.
 *
 * Ce qu'une conversation a établi et qui n'a **aucune raison de lui survivre** :
 * le fichier qu'on est en train de modifier, la branche sur laquelle on
 * travaille, le résultat qu'on vient d'obtenir.
 *
 * La distinction avec la mémoire longue durée n'est pas une nuance de durée,
 * c'est une différence de nature. Un souvenir long terme est un **fait sur
 * l'utilisateur** — il préfère le train, il travaille chez X. Une note de
 * contexte est un **état de travail** — on regarde `auth.ts`. Confondre les deux
 * remplit la mémoire longue durée de scories et fait dire à l'assistant, trois
 * semaines plus tard, qu'on travaille sur un fichier qu'on a oublié.
 *
 * D'où trois propriétés, toutes délibérées :
 *
 *  - **rien n'est persisté.** Ce magasin vit dans le processus.
 *  - **il s'efface.** Chaque note a une durée de vie ; une session abandonnée ne
 *    laisse rien derrière elle.
 *  - **il est borné.** Au-delà de N notes, les plus anciennes tombent. Le
 *    contexte d'un modèle est fini, et une note de contexte illimitée finirait
 *    par manger la place des messages.
 */

export interface ShortTermNote {
  conversationId: string;
  /** Clé stable — réécrire la même clé remplace la note plutôt que d'en ajouter. */
  key: string;
  value: string;
  updatedAt: Date;
  expiresAt: Date;
}

export interface ShortTermContextOptions {
  /** Notes conservées par conversation. Au-delà, la plus ancienne tombe. */
  maxNotesPerConversation?: number;
  /** Durée de vie d'une note. */
  ttlMs?: number;
  now?: () => Date;
}

export class ShortTermContext {
  readonly #notes = new Map<string, Map<string, ShortTermNote>>();
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => Date;

  constructor(options: ShortTermContextOptions = {}) {
    this.#max = options.maxNotesPerConversation ?? 20;
    this.#ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Pose ou remplace une note.
   *
   * La clé fait foi : réécrire `fichier-courant` remplace la valeur au lieu
   * d'empiler deux notes contradictoires, dont le modèle n'aurait aucun moyen de
   * savoir laquelle est à jour.
   */
  set(conversationId: string, key: string, value: string): ShortTermNote {
    const now = this.#now();
    const note: ShortTermNote = {
      conversationId,
      key,
      value,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + this.#ttlMs),
    };

    const bucket = this.#notes.get(conversationId) ?? new Map<string, ShortTermNote>();
    // La suppression préalable remet la clé en fin d'itération : une note
    // rafraîchie ne doit pas tomber parce qu'elle avait été posée en premier.
    bucket.delete(key);
    bucket.set(key, note);

    while (bucket.size > this.#max) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }

    this.#notes.set(conversationId, bucket);
    return note;
  }

  /** Notes vivantes d'une conversation, de la plus ancienne à la plus récente. */
  list(conversationId: string): ShortTermNote[] {
    const bucket = this.#notes.get(conversationId);
    if (bucket === undefined) return [];

    const now = this.#now().getTime();
    const alive: ShortTermNote[] = [];

    for (const [key, note] of bucket) {
      if (note.expiresAt.getTime() <= now) bucket.delete(key);
      else alive.push(note);
    }

    if (bucket.size === 0) this.#notes.delete(conversationId);
    return alive;
  }

  get(conversationId: string, key: string): ShortTermNote | undefined {
    return this.list(conversationId).find((note) => note.key === key);
  }

  delete(conversationId: string, key: string): boolean {
    return this.#notes.get(conversationId)?.delete(key) ?? false;
  }

  /** Vide une conversation. Appelé quand elle est archivée ou fermée. */
  clear(conversationId: string): void {
    this.#notes.delete(conversationId);
  }
}

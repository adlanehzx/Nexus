import { uuidv7 } from "@nexus/shared";
import { AppError, type ErrorSeverity } from "@nexus/shared";

/**
 * Magasins des domaines que l'API expose et qui n'avaient pas encore de service.
 *
 * Utilisateurs, conversations, messages, notifications. Ce sont des **ports**
 * avec une implémentation en mémoire, exactement comme `DeviceStore` ou
 * `TaskStore` ailleurs dans le dépôt : l'implémentation Prisma se branchera
 * dessus sans toucher aux routes, et les tests n'ouvrent aucune connexion.
 *
 * Les domaines qui avaient déjà un service — appareils, sessions d'appareil,
 * tâches, runs agent, confirmations, mémoire — ne sont pas réimplémentés ici.
 * L'API les câble, elle ne les redéfinit pas.
 */

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
  override readonly severity: ErrorSeverity = "warning";

  constructor(what: string, id: string) {
    super({
      message: `${what} introuvable : ${id}`,
      userMessage: "The requested resource does not exist.",
      context: { what, id },
    });
  }
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly httpStatus = 409;
  override readonly severity: ErrorSeverity = "warning";

  constructor(message: string, userMessage: string) {
    super({ message, userMessage });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilisateurs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role d'un compte.
 *
 * `ADMIN` ouvre le tableau de bord de supervision, qui donne une vue **de tout
 * le systeme** : appareils, executants, runs, journaux. Un jeton de client
 * ordinaire ne doit pas y donner acces — sans quoi un telephone perdu
 * exposerait l'infrastructure entiere en plus de la conversation.
 */
export type UserRole = "USER" | "ADMIN";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: Date;
}

export interface UserRecord extends User {
  /** Empreinte scrypt. Ne sort jamais de ce magasin. */
  passwordHash: string;
}

export interface UserStore {
  create(input: { email: string; displayName: string; passwordHash: string }): Promise<User>;
  findById(id: string): Promise<User | undefined>;
  findByEmail(email: string): Promise<UserRecord | undefined>;
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  /** Nombre de comptes. Sert a savoir si l'on cree le premier. */
  count(): Promise<number>;
  /**
   * Change le role d'un compte.
   *
   * Sur le port, et pas seulement sur l'implementation en memoire : le role est
   * lu a chaque requete d'administration, et pouvoir le retirer fait partie du
   * contrat. Un droit qu'on ne sait pas reprendre n'est pas un droit, c'est un
   * acquis.
   */
  setRole(id: string, role: UserRole): Promise<void>;
}

export class InMemoryUserStore implements UserStore {
  readonly #byId = new Map<string, UserRecord>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  create(input: { email: string; displayName: string; passwordHash: string }): Promise<User> {
    const email = normalizeEmail(input.email);
    for (const existing of this.#byId.values()) {
      if (existing.email === email) {
        throw new ConflictError(
          `Adresse déjà enregistrée : ${email}`,
          "Un compte existe déjà avec cette adresse.",
        );
      }
    }

    const record: UserRecord = {
      id: uuidv7(),
      email,
      displayName: input.displayName,
      // Le **premier compte** est celui de la personne qui installe NEXUS : il
      // faut bien que quelqu'un puisse ouvrir le tableau de bord. Les suivants
      // sont des comptes ordinaires. Corollaire a ne pas oublier : une
      // installation exposee doit fermer l'inscription des le premier compte
      // cree, sinon le premier venu devient administrateur.
      role: this.#byId.size === 0 ? "ADMIN" : "USER",
      status: "ACTIVE",
      createdAt: this.#now(),
      passwordHash: input.passwordHash,
    };

    this.#byId.set(record.id, record);
    return Promise.resolve(publicUser(record));
  }

  findById(id: string): Promise<User | undefined> {
    const record = this.#byId.get(id);
    return Promise.resolve(record === undefined ? undefined : publicUser(record));
  }

  findByEmail(email: string): Promise<UserRecord | undefined> {
    const normalized = normalizeEmail(email);
    for (const record of this.#byId.values()) {
      if (record.email === normalized) return Promise.resolve({ ...record });
    }
    return Promise.resolve(undefined);
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const record = this.#byId.get(id);
    if (record !== undefined) this.#byId.set(id, { ...record, passwordHash });
    return Promise.resolve();
  }

  count(): Promise<number> {
    return Promise.resolve(this.#byId.size);
  }

  setRole(id: string, role: UserRole): Promise<void> {
    const record = this.#byId.get(id);
    if (record !== undefined) this.#byId.set(id, { ...record, role });
    return Promise.resolve();
  }
}

/** L'empreinte ne franchit jamais la frontière du magasin. */
function publicUser(record: UserRecord): User {
  const { passwordHash: _passwordHash, ...rest } = record;
  return rest;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions utilisateur
// ─────────────────────────────────────────────────────────────────────────────

export interface UserSession {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  /** Empreinte du jeton de rafraîchissement. La valeur n'est rendue qu'une fois. */
  refreshTokenHash: string;
}

export interface SessionStore {
  create(session: UserSession): Promise<void>;
  get(id: string): Promise<UserSession | undefined>;
  findByRefreshHash(hash: string): Promise<UserSession | undefined>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<number>;
}

export class InMemorySessionStore implements SessionStore {
  readonly #byId = new Map<string, UserSession>();

  create(session: UserSession): Promise<void> {
    this.#byId.set(session.id, { ...session });
    return Promise.resolve();
  }

  get(id: string): Promise<UserSession | undefined> {
    const session = this.#byId.get(id);
    return Promise.resolve(session === undefined ? undefined : { ...session });
  }

  findByRefreshHash(hash: string): Promise<UserSession | undefined> {
    for (const session of this.#byId.values()) {
      if (session.refreshTokenHash === hash) return Promise.resolve({ ...session });
    }
    return Promise.resolve(undefined);
  }

  revoke(id: string, at: Date): Promise<void> {
    const session = this.#byId.get(id);
    if (session !== undefined) this.#byId.set(id, { ...session, revokedAt: at });
    return Promise.resolve();
  }

  revokeAllForUser(userId: string, at: Date): Promise<number> {
    let revoked = 0;
    for (const [id, session] of this.#byId) {
      if (session.userId !== userId || session.revokedAt !== null) continue;
      this.#byId.set(id, { ...session, revokedAt: at });
      revoked += 1;
    }
    return Promise.resolve(revoked);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversations et messages
// ─────────────────────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /**
   * Appareil d'où part le message.
   *
   * Conservé sur le message lui-même : c'est ce qui permet à l'iPhone de savoir
   * qu'une réponse répond à une question posée depuis le portable, et de
   * l'afficher comme telle.
   */
  originClientDeviceId: string | null;
  createdAt: Date;
}

export interface ConversationStore {
  create(input: { userId: string; title: string }): Promise<Conversation>;
  get(id: string): Promise<Conversation | undefined>;
  listByUser(userId: string, page: PageRequest): Promise<Page<Conversation>>;
  archive(id: string): Promise<Conversation>;
  appendMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message>;
  listMessages(conversationId: string, page: PageRequest): Promise<Page<Message>>;
}

export class InMemoryConversationStore implements ConversationStore {
  readonly #conversations = new Map<string, Conversation>();
  readonly #messages = new Map<string, Message[]>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  create(input: { userId: string; title: string }): Promise<Conversation> {
    const at = this.#now();
    const conversation: Conversation = {
      id: uuidv7(),
      userId: input.userId,
      title: input.title,
      status: "ACTIVE",
      createdAt: at,
      updatedAt: at,
    };

    this.#conversations.set(conversation.id, conversation);
    this.#messages.set(conversation.id, []);
    return Promise.resolve({ ...conversation });
  }

  get(id: string): Promise<Conversation | undefined> {
    const conversation = this.#conversations.get(id);
    return Promise.resolve(conversation === undefined ? undefined : { ...conversation });
  }

  listByUser(userId: string, page: PageRequest): Promise<Page<Conversation>> {
    // Les plus récentes d'abord : c'est ce qu'un client affiche en haut.
    const all = [...this.#conversations.values()]
      .filter((conversation) => conversation.userId === userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    return Promise.resolve(paginate(all, page, (conversation) => conversation.id));
  }

  archive(id: string): Promise<Conversation> {
    const conversation = this.#conversations.get(id);
    if (conversation === undefined) throw new NotFoundError("Conversation", id);

    const archived: Conversation = { ...conversation, status: "ARCHIVED", updatedAt: this.#now() };
    this.#conversations.set(id, archived);
    return Promise.resolve({ ...archived });
  }

  appendMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const conversation = this.#conversations.get(input.conversationId);
    if (conversation === undefined) throw new NotFoundError("Conversation", input.conversationId);

    const message: Message = { ...input, id: uuidv7(), createdAt: this.#now() };
    this.#messages.get(input.conversationId)?.push(message);
    this.#conversations.set(conversation.id, { ...conversation, updatedAt: message.createdAt });

    return Promise.resolve({ ...message });
  }

  listMessages(conversationId: string, page: PageRequest): Promise<Page<Message>> {
    const all = this.#messages.get(conversationId) ?? [];
    return Promise.resolve(paginate(all, page, (message) => message.id));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

export interface Notification {
  id: string;
  userId: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  /**
   * Appareil à l'origine de ce qui a produit la notification.
   *
   * `null` pour une notification issue du système. Conservé pour que le client
   * d'origine puisse la présenter différemment — il sait déjà ce qui s'est passé.
   */
  originClientDeviceId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationStore {
  create(input: Omit<Notification, "id" | "createdAt" | "readAt">): Promise<Notification>;
  get(id: string): Promise<Notification | undefined>;
  listByUser(
    userId: string,
    page: PageRequest,
    options?: { unreadOnly?: boolean },
  ): Promise<Page<Notification>>;
  markRead(id: string, at: Date): Promise<Notification>;
}

export class InMemoryNotificationStore implements NotificationStore {
  readonly #byId = new Map<string, Notification>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  create(input: Omit<Notification, "id" | "createdAt" | "readAt">): Promise<Notification> {
    const notification: Notification = {
      ...input,
      id: uuidv7(),
      readAt: null,
      createdAt: this.#now(),
    };

    this.#byId.set(notification.id, notification);
    return Promise.resolve({ ...notification });
  }

  get(id: string): Promise<Notification | undefined> {
    const notification = this.#byId.get(id);
    return Promise.resolve(notification === undefined ? undefined : { ...notification });
  }

  listByUser(
    userId: string,
    page: PageRequest,
    options: { unreadOnly?: boolean } = {},
  ): Promise<Page<Notification>> {
    const all = [...this.#byId.values()]
      .filter((notification) => notification.userId === userId)
      .filter((notification) => !(options.unreadOnly === true) || notification.readAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return Promise.resolve(paginate(all, page, (notification) => notification.id));
  }

  markRead(id: string, at: Date): Promise<Notification> {
    const notification = this.#byId.get(id);
    if (notification === undefined) throw new NotFoundError("Notification", id);

    const read: Notification = { ...notification, readAt: notification.readAt ?? at };
    this.#byId.set(id, read);
    return Promise.resolve({ ...read });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pagination par curseur, et non par décalage.
 *
 * Un `?page=3` sur une liste qui bouge saute ou répète des éléments : une
 * conversation ajoutée entre deux appels décale tout. Un curseur désigne un
 * point précis dans la liste, ce qui reste juste quoi qu'il arrive entre-temps.
 */
export interface PageRequest {
  /** Identifiant après lequel reprendre. Absent = depuis le début. */
  cursor?: string | undefined;
  limit: number;
}

export interface Page<T> {
  items: T[];
  /** À passer en `cursor` pour la page suivante. `null` = fin de liste. */
  nextCursor: string | null;
  total: number;
}

export function paginate<T>(
  all: readonly T[],
  page: PageRequest,
  idOf: (item: T) => string,
): Page<T> {
  const start =
    page.cursor === undefined ? 0 : all.findIndex((item) => idOf(item) === page.cursor) + 1;

  // Un curseur inconnu — élément supprimé entre deux appels — repart du début
  // plutôt que de renvoyer une liste vide sans explication.
  const from = start <= 0 && page.cursor !== undefined ? 0 : start;
  const items = all.slice(from, from + page.limit);
  const last = items.at(-1);

  return {
    items,
    nextCursor: from + items.length < all.length && last !== undefined ? idOf(last) : null,
    total: all.length,
  };
}

import { uuidv7 } from "@nexus/shared";
import { AppError, type ErrorSeverity } from "@nexus/shared";

/**
 * Stores for domains exposed by the API that did not previously have a dedicated service.
 *
 * Users, conversations, messages, notifications. These are **ports**
 * with in-memory implementations, matching `DeviceStore` and
 * `TaskStore` elsewhere in the repository: Prisma implementations plug
 * into them without changing routes, and tests need no network connection.
 *
 * Domains that already had a service — devices, device sessions,
 * tasks, agent runs, confirmations, memory — are not re-implemented here.
 * The API wires them, it does not redefine them.
 */

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
  override readonly severity: ErrorSeverity = "warning";

  constructor(what: string, id: string) {
    super({
      message: `${what} not found: ${id}`,
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
// Users
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role of an account.
 *
 * `ADMIN` opens the supervision dashboard, which provides an overview **of the entire
 * system**: devices, workers, runs, logs. A standard client token
 * must not grant access — otherwise a lost phone
 * would expose the entire infrastructure in addition to chat history.
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
  /** Scrypt hash. Never leaves this store. */
  passwordHash: string;
}

export interface UserStore {
  create(input: { email: string; displayName: string; passwordHash: string }): Promise<User>;
  findById(id: string): Promise<User | undefined>;
  findByEmail(email: string): Promise<UserRecord | undefined>;
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  /** Number of accounts. Used to determine if creating the initial account. */
  count(): Promise<number>;
  /**
   * Updates an account's role.
   *
   * Defined on the port, not just the in-memory implementation: the role is
   * checked on every administrative request, and ability to revoke it is part of
   * the contract. A privilege that cannot be revoked is not a privilege, it is an
   * entitlement.
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
          `Email already registered: ${email}`,
          "An account already exists with this email address.",
        );
      }
    }

    const record: UserRecord = {
      id: uuidv7(),
      email,
      displayName: input.displayName,
      // The **initial account** belongs to whoever installs NEXUS: someone
      // must be able to access the dashboard. Subsequent accounts
      // are standard users. Important operational corollary: an
      // exposed installation must close registration once the first account
      // is created, otherwise the next registrant becomes administrator.
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

/** Password hashes never leave the store boundary. */
function publicUser(record: UserRecord): User {
  const { passwordHash: _passwordHash, ...rest } = record;
  return rest;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// User sessions
// ─────────────────────────────────────────────────────────────────────────────

export interface UserSession {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  /** Hash of the refresh token. The raw token is returned only once. */
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
// Conversations and messages
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
   * Device that sent the message.
   *
   * Retained on the message itself: allows an iPhone client to know
   * that a response answers a question asked from a laptop, and
   * display it accordingly.
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
    // Most recent first: matches what clients display at the top.
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
   * Device that produced the notification.
   *
   * `null` for a system notification. Retained so the originating
   * client can present it differently — it already knows what happened.
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
 * Cursor-based pagination rather than offset-based.
 *
 * A `?page=3` on an active list skips or duplicates items: a
 * conversation added between calls shifts everything. A cursor references a
 * specific point in the list, remaining accurate regardless of concurrent changes.
 */
export interface PageRequest {
  /** Identifier after which to resume. Omitted = from the beginning. */
  cursor?: string | undefined;
  limit: number;
}

export interface Page<T> {
  items: T[];
  /** Pass as `cursor` for the next page. `null` = end of list. */
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

  // An unknown cursor — item deleted between calls — restarts from the beginning
  // rather than returning an empty list without explanation.
  const from = start <= 0 && page.cursor !== undefined ? 0 : start;
  const items = all.slice(from, from + page.limit);
  const last = items.at(-1);

  return {
    items,
    nextCursor: from + items.length < all.length && last !== undefined ? idOf(last) : null,
    total: all.length,
  };
}

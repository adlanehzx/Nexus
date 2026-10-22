import { AppError, type ErrorSeverity } from "@nexus/shared";
import type { HttpClient, SecureStorage } from "./ports.js";

/**
 * User session on the device.
 *
 * Three responsibilities, and the third is the least obvious:
 *
 *  1. **persist tokens in secure storage**, never in memory alone or
 *     in plaintext storage;
 *  2. **refresh before expiration**, transparently;
 *  3. **refresh only once**, even if ten requests fail at the same
 *     time. Without this guard, the application would send ten concurrent
 *     refreshes, nine of which would present an already-consumed token — and the
 *     server, treating a replayed token as theft, would invalidate all
 *     sessions. The most vicious bug for this kind of client.
 *
 * **No server secrets are embedded in the client application.** It only knows
 * the core server address and the tokens obtained upon logging in. A mobile
 * or client application can be decompiled; what is stored there is public.
 */

const ACCESS_KEY = "nexus.access";
const REFRESH_KEY = "nexus.refresh";
const DEVICE_KEY = "nexus.device";
/**
 * User for whom the current device was bound.
 *
 * Kept for one reason: `nexus.device` designates a device record that
 * **belongs to an account**. If a second account logs in on the same
 * phone, reusing this ID would mean acting on behalf of someone else's
 * device. The core server would reject it — it verifies ownership — but the
 * client would remain stuck in a rejected handshake without understanding why.
 */
const USER_KEY = "nexus.user";

export class NotAuthenticatedError extends AppError {
  readonly code = "CLIENT_NOT_AUTHENTICATED";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";

  constructor(reason: string) {
    super({
      message: `Missing or invalid session: ${reason}`,
      userMessage: "Sign in to continue.",
      context: { reason },
    });
  }
}

export class LoginFailedError extends AppError {
  readonly code = "CLIENT_LOGIN_FAILED";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";

  constructor(userMessage: string) {
    super({ message: `Sign-in refused: ${userMessage}`, userMessage });
  }
}

/** Summary exposed by an account device sufficient to identify it. */
interface DeviceSummary {
  id: string;
  name: string;
  type: string;
  role: string;
  trust: string;
}

/**
 * Result of `ensureDevice`.
 *
 * `origin` indicates **what happened**, not just what was obtained: an
 * interface that just registered a device must explain waiting for
 * approval, whereas a silent attachment should show nothing.
 */
export interface EnsuredDevice {
  deviceId: string;
  /**
   * `session`: already attached, nothing requested from the core server.
   * `existing`: an existing account record was reused.
   * `registered`: a new device was just created, and is in `PENDING` state.
   */
  origin: "session" | "existing" | "registered";
  /** Known only when the core server just reported it. */
  trust?: string;
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** Device under which this client is registered with the core server. */
  deviceId: string | null;
  /** Account to which `deviceId` belongs. `null` while unknown. */
  userId: string | null;
}

export interface SessionManagerOptions {
  http: HttpClient;
  storage: SecureStorage;
  now?: () => Date;
  /** Called when the session becomes invalid and re-authentication is required. */
  onSignedOut?: (reason: string) => void;
}

export interface ServerReadiness {
  status: "ok" | "degraded" | "down";
  version?: string | undefined;
  uptimeSeconds?: number | undefined;
  dependencies?: {
    database?: { status: "up" | "down"; latencyMs?: number | undefined } | undefined;
    redis?: { status: "up" | "down"; latencyMs?: number | undefined } | undefined;
  } | undefined;
  diagnostic?: string | undefined;
}

export class SessionManager {
  readonly #http: HttpClient;
  readonly #storage: SecureStorage;
  readonly #onSignedOut: ((reason: string) => void) | undefined;

  #session: StoredSession | undefined;
  /**
   * Refresh currently in flight.
   *
   * This shared promise prevents ten concurrent requests from triggering ten
   * simultaneous rotations.
   */
  #refreshing: Promise<string> | undefined;

  constructor(options: SessionManagerOptions) {
    this.#http = options.http;
    this.#storage = options.storage;
    this.#onSignedOut = options.onSignedOut;
  }

  get isAuthenticated(): boolean {
    return this.#session !== undefined;
  }

  get deviceId(): string | null {
    return this.#session?.deviceId ?? null;
  }

  get userId(): string | null {
    return this.#session?.userId ?? null;
  }

  /** Restores the session from secure storage on application startup. */
  async restore(): Promise<boolean> {
    const [accessToken, refreshToken, deviceId, userId] = await Promise.all([
      this.#storage.get(ACCESS_KEY),
      this.#storage.get(REFRESH_KEY),
      this.#storage.get(DEVICE_KEY),
      this.#storage.get(USER_KEY),
    ]);

    if (accessToken === undefined || refreshToken === undefined) return false;

    this.#session = {
      accessToken,
      refreshToken,
      deviceId: deviceId ?? null,
      userId: userId ?? null,
    };
    return true;
  }

  async login(email: string, password: string): Promise<void> {
    const response = await this.#http.request({
      method: "POST",
      path: "/api/v1/auth/login",
      body: { email, password },
    });

    if (response.status !== 200) {
      throw new LoginFailedError(messageOf(response.body, "Incorrect email or password."));
    }

    const body = response.body as {
      data: {
        user?: { id?: string };
        tokens: { accessToken: string; refreshToken: string };
      };
    };

    const userId = body.data.user?.id ?? null;

    // A device ID designates a record that **belongs to a user**.
    // Retaining it when logging in as another user would cause the client
    // to present a device that is not theirs: the handshake would be
    // rejected indefinitely without clear explanation.
    //
    // The comparison only occurs if both accounts are known. Secure storage
    // written by an earlier version does not carry a user ID; we do not want
    // to destroy a valid attachment simply due to missing information.
    const previousUserId = this.#session?.userId ?? null;
    const accountChanged = userId !== null && previousUserId !== null && userId !== previousUserId;

    await this.#persist({
      accessToken: body.data.tokens.accessToken,
      refreshToken: body.data.tokens.refreshToken,
      deviceId: accountChanged ? null : (this.#session?.deviceId ?? null),
      userId: userId ?? previousUserId,
    });

    if (accountChanged) await this.#storage.remove(DEVICE_KEY);
  }

  async register(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<void> {
    const response = await this.#http.request({
      method: "POST",
      path: "/api/v1/auth/register",
      body: input,
    });

    if (response.status !== 201) {
      throw new LoginFailedError(messageOf(response.body, "Registration failed."));
    }

    const body = response.body as {
      data: {
        user?: { id?: string };
        tokens: { accessToken: string; refreshToken: string };
      };
    };

    const userId = body.data.user?.id ?? null;
    const previousUserId = this.#session?.userId ?? null;
    const accountChanged = userId !== null && previousUserId !== null && userId !== previousUserId;

    await this.#persist({
      accessToken: body.data.tokens.accessToken,
      refreshToken: body.data.tokens.refreshToken,
      deviceId: accountChanged ? null : (this.#session?.deviceId ?? null),
      userId: userId ?? previousUserId,
    });

    if (accountChanged) await this.#storage.remove(DEVICE_KEY);
  }

  /**
   * Probes the server readiness probe without exposing secrets.
   */
  async checkReadiness(): Promise<ServerReadiness> {
    try {
      const response = await this.#http.request({
        method: "GET",
        path: "/api/v1/health",
      });

      const body = response.body as {
        status?: "ok" | "degraded";
        version?: string;
        uptimeSeconds?: number;
        dependencies?: {
          database?: { status: "up" | "down"; latencyMs?: number };
          redis?: { status: "up" | "down"; latencyMs?: number };
        };
      } | null;

      if (response.status === 200 && body?.status === "ok") {
        return {
          status: "ok",
          version: body.version,
          uptimeSeconds: body.uptimeSeconds,
          dependencies: body.dependencies,
        };
      }

      return {
        status: "degraded",
        version: body?.version,
        uptimeSeconds: body?.uptimeSeconds,
        dependencies: body?.dependencies,
        diagnostic: `Readiness returned HTTP ${response.status} (${body?.status ?? "unknown"})`,
      };
    } catch (cause) {
      return {
        status: "down",
        diagnostic: cause instanceof Error ? cause.message : "Service unreachable",
      };
    }
  }

  /**
   * Ends the session.
   *
   * Secure storage is cleared **even if the server call fails**. A user
   * tapping "Sign out" offline or in poor connectivity must see their session
   * cleared from the device regardless of network status.
   */
  async logout(): Promise<void> {
    const token = this.#session?.accessToken;

    if (token !== undefined) {
      await this.#http
        .request({
          method: "POST",
          path: "/api/v1/auth/logout",
          headers: { authorization: `Bearer ${token}` },
        })
        .catch(() => undefined);
    }

    await this.#clear("sign-out requested");
  }

  /** Current access token. */
  accessToken(): string {
    const token = this.#session?.accessToken;
    if (token === undefined) throw new NotAuthenticatedError("no token in memory");
    return token;
  }

  /**
   * Rotates the token, one at a time.
   *
   * Concurrent callers await the same promise. This prevents presenting an
   * already-consumed token to the server, which would rightly interpret it as theft.
   */
  refresh(): Promise<string> {
    if (this.#refreshing !== undefined) return this.#refreshing;

    const refreshToken = this.#session?.refreshToken;
    if (refreshToken === undefined) {
      return Promise.reject(new NotAuthenticatedError("no refresh token"));
    }

    this.#refreshing = this.#doRefresh(refreshToken).finally(() => {
      this.#refreshing = undefined;
    });

    return this.#refreshing;
  }

  async #doRefresh(refreshToken: string): Promise<string> {
    const response = await this.#http.request({
      method: "POST",
      path: "/api/v1/auth/refresh",
      body: { refreshToken },
    });

    if (response.status !== 200) {
      // The server rejected: token expired, revoked, or replayed. In all
      // cases the session is dead, and retrying will not resurrect it.
      await this.#clear("refresh rejected");
      throw new NotAuthenticatedError("refresh rejected");
    }

    const body = response.body as { data: { accessToken: string; refreshToken: string } };
    await this.#persist({
      accessToken: body.data.accessToken,
      refreshToken: body.data.refreshToken,
      deviceId: this.#session?.deviceId ?? null,
      userId: this.#session?.userId ?? null,
    });

    return body.data.accessToken;
  }

  /**
   * Registers this device as a NEXUS client.
   *
   * The private key remains on the device; only the public key is sent.
   * The device arrives as **unapproved**: it must be approved, which is the
   * intended behavior — an auto-approving device provides no guarantees.
   *
   * The role is requested, never imposed. A machine that also runs tasks
   * announces `BOTH`, but the core server decides: nothing written here expands
   * what the device is permitted to do. As evidence, `grantedPermissions` is sent
   * **empty** — the device grants itself nothing.
   */
  async registerDevice(input: {
    name: string;
    /** Optional for CLIENT: only WORKER devices sign commands. */
    publicKeyPem?: string;
    type?: "IPHONE" | "ANDROID" | "WINDOWS_PC" | "MAC" | "LINUX";
    platform?: "IOS" | "ANDROID" | "WINDOWS" | "MACOS" | "LINUX";
    role?: "CLIENT" | "WORKER" | "BOTH";
  }): Promise<string> {
    const response = await this.#authorized({
      method: "POST",
      path: "/api/v1/devices",
      body: {
        name: input.name,
        type: input.type ?? "IPHONE",
        platform: input.platform ?? "IOS",
        role: input.role ?? "CLIENT",
        ...(input.publicKeyPem === undefined ? {} : { publicKeyPem: input.publicKeyPem }),
        grantedPermissions: [],
      },
    });

    if (response.status !== 201) {
      throw new AppErrorFromResponse(response.body, "Device registration rejected.");
    }

    const deviceId = (response.body as { data: { id: string } }).data.id;
    await this.#persist({ ...this.#requireSession(), deviceId });

    return deviceId;
  }

  /**
   * Binds this session to an **already registered** device.
   *
   * This is the desktop/worker path. Its device record already exists: it
   * was created by the worker daemon, which holds the machine's private key
   * and paired it with the `BOTH` role. The client interface therefore creates
   * nothing — it reuses the same identifier, and the core server recognizes
   * this host whether it speaks over the client channel or worker channel.
   *
   * This binding **does not authenticate anything**. It specifies where requests
   * originate; the token specifies who is speaking, and the core server verifies
   * that the device belongs to the token bearer. A device ID alone was never proof.
   */
  async bindDevice(deviceId: string): Promise<void> {
    await this.#persist({ ...this.#requireSession(), deviceId });
  }

  /**
   * Ensures the session speaks on behalf of a device, without creating duplicates.
   *
   * This is the step needed after sign-in: the `/ws/client` channel announces
   * **where** requests come from, and a session without a device has nothing to
   * announce. The client would otherwise remain stuck in "reconnecting" state
   * even though neither the network nor the token was at fault.
   *
   * Three paths, in this order:
   *
   *  1. **a device is already attached** — nothing is requested, nothing is
   *     checked with the core server; this applies to all launches except the
   *     first, and must remain zero-cost;
   *  2. **the account already owns this device** — reinstallation, cleared
   *     secure storage, or device replacement with the same name: rebind to the
   *     existing record. Without this path, each reinstallation would add
   *     another "Alex's iPhone" to the fleet, requiring manual approval each time;
   *  3. **no device matches** — only then register a new one.
   *
   * Matching is done on **name**, with matching role and type. This is the only
   * stable reference available to a client that just lost its secure storage:
   * it has no identifier, and distinct devices have distinct names. A revoked
   * device is never reused — reusing it would effectively cancel the revocation.
   *
   * What this method **does not grant**: nothing. The created device arrives in
   * `PENDING` state without permissions, and the real-time channel remains closed
   * until approved by an already-approved client. This preserves the authorization model.
   */
  async ensureDevice(input: {
    name: string;
    type?: "IPHONE" | "ANDROID" | "WINDOWS_PC" | "MAC" | "LINUX";
    platform?: "IOS" | "ANDROID" | "WINDOWS" | "MACOS" | "LINUX";
    role?: "CLIENT" | "WORKER" | "BOTH";
    publicKeyPem?: string;
  }): Promise<EnsuredDevice> {
    const existing = this.deviceId;
    if (existing !== null) return { deviceId: existing, origin: "session" };

    const type = input.type ?? "IPHONE";
    const role = input.role ?? "CLIENT";

    const known = await this.#findOwnDevice({ name: input.name, type, role });
    if (known !== undefined) {
      await this.bindDevice(known.id);
      return { deviceId: known.id, origin: "existing", trust: known.trust };
    }

    const deviceId = await this.registerDevice({
      name: input.name,
      type,
      role,
      ...(input.platform === undefined ? {} : { platform: input.platform }),
      ...(input.publicKeyPem === undefined ? {} : { publicKeyPem: input.publicKeyPem }),
    });

    // A fresh device is never approved: returning it here prevents the caller
    // from assuming approval and allows displaying the pending state.
    return { deviceId, origin: "registered", trust: "PENDING" };
  }

  /**
   * Looks up the account device that corresponds to this one.
   *
   * An unreadable list is not a fatal error: returns `undefined` so the caller
   * can register. An extra device is preferable to an impossible connection.
   */
  async #findOwnDevice(criteria: {
    name: string;
    type: string;
    role: string;
  }): Promise<{ id: string; trust: string } | undefined> {
    const response = await this.#authorized({
      method: "GET",
      path: "/api/v1/devices?limit=100",
    });

    if (response.status !== 200) return undefined;

    const devices = (response.body as { data?: unknown }).data;
    if (!Array.isArray(devices)) return undefined;

    const match = devices.find((device): device is DeviceSummary => {
      if (device === null || typeof device !== "object") return false;
      const candidate = device as Partial<DeviceSummary>;
      return (
        typeof candidate.id === "string" &&
        candidate.name === criteria.name &&
        candidate.type === criteria.type &&
        // A machine announced as `BOTH` also serves as a client: reusing it avoids
        // duplicating the machine in the fleet list.
        (candidate.role === criteria.role || candidate.role === "BOTH") &&
        candidate.trust !== "REVOKED"
      );
    });

    return match === undefined ? undefined : { id: match.id, trust: match.trust };
  }

  /**
   * Authenticated request with transparent refresh.
   *
   * A 401 triggers **one** rotation and **one** retry. No loop: if the new
   * token is also rejected, the issue is not token expiration, and retrying
   * indefinitely would turn an error into a request storm.
   */
  async #authorized(input: Parameters<HttpClient["request"]>[0]) {
    const withToken = (token: string) => ({
      ...input,
      headers: { ...input.headers, authorization: `Bearer ${token}` },
    });

    const first = await this.#http.request(withToken(this.accessToken()));
    if (first.status !== 401) return first;

    const refreshed = await this.refresh();
    return this.#http.request(withToken(refreshed));
  }

  /** Exposed for `ApiClient`, avoiding duplicate logic. */
  authorizedRequest(input: Parameters<HttpClient["request"]>[0]) {
    return this.#authorized(input);
  }

  #requireSession(): StoredSession {
    if (this.#session === undefined) throw new NotAuthenticatedError("missing session");
    return this.#session;
  }

  async #persist(session: StoredSession): Promise<void> {
    this.#session = session;

    await Promise.all([
      this.#storage.set(ACCESS_KEY, session.accessToken),
      this.#storage.set(REFRESH_KEY, session.refreshToken),
      session.deviceId === null
        ? Promise.resolve()
        : this.#storage.set(DEVICE_KEY, session.deviceId),
      session.userId === null ? Promise.resolve() : this.#storage.set(USER_KEY, session.userId),
    ]);
  }

  /**
   * Clears everything identifying the session, **including device binding**.
   *
   * Leaving `nexus.device` behind was a trap: the next account would reuse the
   * previous device, the core server would reject the handshake (verifying ownership),
   * and the channel would remain closed without an actionable error message.
   * Signing out clears device binding so the next login registers or rebinds its own.
   */
  async #clear(reason: string): Promise<void> {
    this.#session = undefined;

    await Promise.all([
      this.#storage.remove(ACCESS_KEY),
      this.#storage.remove(REFRESH_KEY),
      this.#storage.remove(DEVICE_KEY),
      this.#storage.remove(USER_KEY),
    ]);

    this.#onSignedOut?.(reason);
  }
}

/** Error reconstructed from a server response. */
class AppErrorFromResponse extends AppError {
  readonly code: string;
  readonly httpStatus = 400;

  constructor(body: unknown, fallback: string) {
    const message = messageOf(body, fallback);
    super({ message, userMessage: message });
    this.code = codeOf(body);
  }
}

function messageOf(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (error !== null && typeof error === "object" && "message" in error) {
      return String(error.message);
    }
  }
  return fallback;
}

function codeOf(body: unknown): string {
  if (body !== null && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (error !== null && typeof error === "object" && "code" in error) {
      return String(error.code);
    }
  }
  return "CLIENT_REQUEST_FAILED";
}

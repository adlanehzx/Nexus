import { AppError, type ErrorSeverity } from "@nexus/shared";
import type { HttpClient, SecureStorage } from "./ports.js";

/**
 * Session de l'utilisateur sur l'iPhone.
 *
 * Trois responsabilités, et la troisième est la moins évidente :
 *
 *  1. **conserver les jetons dans le trousseau**, jamais en mémoire seule ni
 *     dans un stockage en clair ;
 *  2. **rafraîchir avant expiration**, de façon transparente ;
 *  3. **ne rafraîchir qu'une fois**, même si dix requêtes échouent en même
 *     temps. Sans cette garde, l'application enverrait dix rafraîchissements
 *     concurrents, dont neuf présenteraient un jeton déjà consommé — et le
 *     serveur, qui traite un jeton rejoué comme un vol, fermerait toutes les
 *     sessions. Le bogue le plus vicieux de ce genre de client.
 *
 * **Aucun secret du serveur n'est embarqué dans l'application.** Elle ne connaît
 * que l'adresse du cœur et les jetons que l'utilisateur a obtenus en se
 * connectant. Une application mobile est décompilable ; ce qui y est écrit est
 * public.
 */

const ACCESS_KEY = "nexus.access";
const REFRESH_KEY = "nexus.refresh";
const DEVICE_KEY = "nexus.device";

export class NotAuthenticatedError extends AppError {
  readonly code = "CLIENT_NOT_AUTHENTICATED";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";

  constructor(reason: string) {
    super({
      message: `Session absente ou invalide : ${reason}`,
      userMessage: "Connectez-vous pour continuer.",
      context: { reason },
    });
  }
}

export class LoginFailedError extends AppError {
  readonly code = "CLIENT_LOGIN_FAILED";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";

  constructor(userMessage: string) {
    super({ message: `Connexion refusée : ${userMessage}`, userMessage });
  }
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** Appareil sous lequel ce téléphone est enregistré auprès du cœur. */
  deviceId: string | null;
}

export interface SessionManagerOptions {
  http: HttpClient;
  storage: SecureStorage;
  now?: () => Date;
  /** Appelée quand la session devient invalide et qu'il faut se reconnecter. */
  onSignedOut?: (reason: string) => void;
}

export class SessionManager {
  readonly #http: HttpClient;
  readonly #storage: SecureStorage;
  readonly #onSignedOut: ((reason: string) => void) | undefined;

  #session: StoredSession | undefined;
  /**
   * Rafraîchissement en cours.
   *
   * C'est cette promesse partagée qui empêche dix requêtes simultanées de
   * déclencher dix rotations concurrentes.
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

  /** Recharge la session depuis le trousseau au démarrage de l'application. */
  async restore(): Promise<boolean> {
    const [accessToken, refreshToken, deviceId] = await Promise.all([
      this.#storage.get(ACCESS_KEY),
      this.#storage.get(REFRESH_KEY),
      this.#storage.get(DEVICE_KEY),
    ]);

    if (accessToken === undefined || refreshToken === undefined) return false;

    this.#session = { accessToken, refreshToken, deviceId: deviceId ?? null };
    return true;
  }

  async login(email: string, password: string): Promise<void> {
    const response = await this.#http.request({
      method: "POST",
      path: "/api/v1/auth/login",
      body: { email, password },
    });

    if (response.status !== 200) {
      throw new LoginFailedError(messageOf(response.body, "Adresse ou mot de passe incorrect."));
    }

    const body = response.body as {
      data: { tokens: { accessToken: string; refreshToken: string } };
    };

    await this.#persist({
      accessToken: body.data.tokens.accessToken,
      refreshToken: body.data.tokens.refreshToken,
      deviceId: this.#session?.deviceId ?? null,
    });
  }

  /**
   * Ferme la session.
   *
   * Le trousseau est vidé **même si l'appel au serveur échoue**. Un utilisateur
   * qui appuie sur « se déconnecter » dans le métro doit voir sa session
   * disparaître de l'appareil, quoi qu'en pense le réseau.
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

    await this.#clear("déconnexion demandée");
  }

  /** Jeton d'accès courant. */
  accessToken(): string {
    const token = this.#session?.accessToken;
    if (token === undefined) throw new NotAuthenticatedError("aucun jeton en mémoire");
    return token;
  }

  /**
   * Fait tourner le jeton, une seule fois à la fois.
   *
   * Les appelants concurrents attendent la même promesse. C'est ce qui évite de
   * présenter au serveur un jeton déjà consommé, qu'il interpréterait — à juste
   * titre — comme un vol.
   */
  refresh(): Promise<string> {
    if (this.#refreshing !== undefined) return this.#refreshing;

    const refreshToken = this.#session?.refreshToken;
    if (refreshToken === undefined) {
      return Promise.reject(new NotAuthenticatedError("aucun jeton de rafraîchissement"));
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
      // Le serveur a refusé : jeton expiré, révoqué, ou rejoué. Dans tous les
      // cas la session est morte, et insister ne la ressuscitera pas.
      await this.#clear("rafraîchissement refusé");
      throw new NotAuthenticatedError("rafraîchissement refusé");
    }

    const body = response.body as { data: { accessToken: string; refreshToken: string } };
    await this.#persist({
      accessToken: body.data.accessToken,
      refreshToken: body.data.refreshToken,
      deviceId: this.#session?.deviceId ?? null,
    });

    return body.data.accessToken;
  }

  /**
   * Enregistre cet appareil comme client NEXUS.
   *
   * La clé privée reste sur l'appareil ; seule la clé publique part. L'appareil
   * arrive **non approuvé** : il faudra l'approuver, ce qui est le
   * comportement voulu — un appareil qui s'auto-approuve n'apporte aucune
   * garantie.
   *
   * Le rôle est demandé, jamais imposé. Un poste qui exécute aussi des tâches
   * s'annonce `BOTH`, mais c'est le cœur qui tranche : rien de ce qui est écrit
   * ici n'élargit ce que l'appareil aura le droit de faire. La preuve en est que
   * `grantedPermissions` part **vide** — l'appareil ne s'accorde rien.
   */
  async registerDevice(input: {
    name: string;
    publicKeyPem: string;
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
        publicKeyPem: input.publicKeyPem,
        grantedPermissions: [],
      },
    });

    if (response.status !== 201) {
      throw new AppErrorFromResponse(response.body, "Enregistrement de l'appareil refusé.");
    }

    const deviceId = (response.body as { data: { id: string } }).data.id;
    await this.#persist({ ...this.#requireSession(), deviceId });

    return deviceId;
  }

  /**
   * Rattache cette session à un appareil **déjà enregistré**.
   *
   * C'est le chemin du portable Windows. Sa ligne d'appareil existe déjà : elle
   * a été créée par le démon exécutant, qui détient la clé privée de la machine
   * et l'a appairée en rôle `BOTH`. L'interface ne recrée donc rien — elle
   * reprend le même identifiant, et le cœur reconnaît « ce poste » qu'il parle
   * sur le canal client ou sur le canal worker.
   *
   * Ce rattachement **n'authentifie rien**. Il dit d'où l'on parle ; le jeton
   * dit qui parle, et le cœur vérifie que l'appareil appartient bien au
   * porteur du jeton. Un identifiant d'appareil seul n'a jamais été une preuve.
   */
  async bindDevice(deviceId: string): Promise<void> {
    await this.#persist({ ...this.#requireSession(), deviceId });
  }

  /**
   * Requête authentifiée, avec rafraîchissement transparent.
   *
   * Un 401 déclenche **une** rotation puis **un** réessai. Pas de boucle : si le
   * jeton neuf est refusé lui aussi, le problème n'est pas le jeton, et
   * réessayer indéfiniment transformerait une erreur en tempête de requêtes.
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

  /** Exposé pour l'`ApiClient`, qui n'a pas à reproduire cette logique. */
  authorizedRequest(input: Parameters<HttpClient["request"]>[0]) {
    return this.#authorized(input);
  }

  #requireSession(): StoredSession {
    if (this.#session === undefined) throw new NotAuthenticatedError("session absente");
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
    ]);
  }

  async #clear(reason: string): Promise<void> {
    this.#session = undefined;

    await Promise.all([this.#storage.remove(ACCESS_KEY), this.#storage.remove(REFRESH_KEY)]);

    this.#onSignedOut?.(reason);
  }
}

/** Erreur reconstruite depuis une réponse du serveur. */
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

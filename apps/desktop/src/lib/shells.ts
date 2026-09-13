import type { SecureStorage } from "@nexus/client-core";
import { VolatileStorage, type DesktopShell, type ShellKind } from "./shell.js";

/**
 * Les deux coquilles possibles, et la façon de choisir.
 *
 * En production, Tauri : la fenêtre native, le gestionnaire d'identifiants
 * Windows, les notifications du système. En développement, un navigateur
 * ordinaire, avec des capacités réduites et **annoncées comme telles**.
 *
 * Rien ici ne dégrade la sécurité en silence. La coquille web ne fait pas
 * semblant d'avoir un coffre : elle garde les jetons en mémoire et les perd au
 * rechargement. C'est gênant, c'est voulu, et c'est écrit à l'écran.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tauri
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pont vers la coquille Rust.
 *
 * Quatre commandes, pas une de plus. La liste est le contrat de sécurité de
 * l'application : ce que le moteur de rendu peut demander au système est
 * exactement ce qui est énuméré ici, et la coquille Rust n'expose rien d'autre.
 *
 * On y cherchera en vain une commande d'exécution : l'interface n'exécute pas.
 */
interface TauriBridge {
  invoke(command: TauriCommand, args?: Record<string, unknown>): Promise<unknown>;
}

type TauriCommand =
  | "secret_get"
  | "secret_set"
  | "secret_remove"
  | "notify"
  | "local_worker_device_id"
  | "machine_name"
  | "open_external";

/**
 * Le pont exposé par la coquille native, s'il y en a une.
 *
 * `__TAURI__` n'existe que parce que `tauri.conf.json` déclare
 * `app.withGlobalTauri: true`. C'est délibéré : le frontend passe par cette
 * globale plutôt que par le paquet `@tauri-apps/api` — une dépendance de moins,
 * et la surface atteignable reste celle des sept commandes énumérées ci-dessus.
 *
 * Le drapeau se supprime sans rien casser au build : `detectShell()` retomberait
 * simplement sur `WebShell`, et l'application empaquetée perdrait en silence le
 * trousseau Windows et les notifications natives. D'où ce rappel ici.
 */
function tauriBridge(): TauriBridge | undefined {
  const scope = globalThis as unknown as { __TAURI__?: { core?: TauriBridge } };
  return scope.__TAURI__?.core;
}

/** Coffre adossé au gestionnaire d'identifiants de Windows. */
class KeyringStorage implements SecureStorage {
  readonly #bridge: TauriBridge;

  constructor(bridge: TauriBridge) {
    this.#bridge = bridge;
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.#bridge.invoke("secret_get", { key });
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.#bridge.invoke("secret_set", { key, value });
  }

  async remove(key: string): Promise<void> {
    await this.#bridge.invoke("secret_remove", { key });
  }
}

class TauriShell implements DesktopShell {
  readonly kind: ShellKind = "tauri";
  readonly storage: SecureStorage;
  readonly #bridge: TauriBridge;

  constructor(bridge: TauriBridge) {
    this.#bridge = bridge;
    this.storage = new KeyringStorage(bridge);
  }

  async notify(input: {
    title: string;
    body: string;
    severity: "info" | "warning" | "error";
  }): Promise<void> {
    await this.#bridge.invoke("notify", input);
  }

  async localWorkerDeviceId(): Promise<string | null> {
    const value = await this.#bridge.invoke("local_worker_device_id");
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  async machineName(): Promise<string> {
    const value = await this.#bridge.invoke("machine_name");
    return typeof value === "string" && value.length > 0 ? value : "Poste Windows";
  }

  async openExternal(url: string): Promise<void> {
    await this.#bridge.invoke("open_external", { url });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigateur
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coquille de repli.
 *
 * Utilisée quand l'interface tourne dans un navigateur ordinaire — le mode de
 * développement. Trois différences, toutes visibles :
 *
 *  - les jetons vivent en mémoire et disparaissent au rechargement ;
 *  - il n'y a pas d'exécutant local à découvrir, puisqu'un navigateur ne lit
 *    pas le disque ;
 *  - les notifications passent par l'API du navigateur, si l'utilisateur l'a
 *    autorisée.
 */
class WebShell implements DesktopShell {
  readonly kind: ShellKind = "web";
  readonly storage: SecureStorage = new VolatileStorage();

  async notify(input: { title: string; body: string }): Promise<void> {
    if (!("Notification" in globalThis)) return;
    if (Notification.permission === "denied") return;

    if (Notification.permission === "default") {
      const granted = await Notification.requestPermission();
      if (granted !== "granted") return;
    }

    new Notification(input.title, { body: input.body });
  }

  /**
   * Toujours `null`.
   *
   * Un navigateur ne lit pas l'état d'un démon sur le disque, et c'est une
   * bonne chose. L'interface affichera « aucun exécutant détecté », ce qui est
   * la vérité de ce contexte d'exécution.
   */
  localWorkerDeviceId(): Promise<string | null> {
    return Promise.resolve(null);
  }

  machineName(): Promise<string> {
    return Promise.resolve("Poste Windows");
  }

  openExternal(url: string): Promise<void> {
    globalThis.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  }
}

/** Choisit la coquille disponible. Tauri s'il est là, le navigateur sinon. */
export function detectShell(): DesktopShell {
  const bridge = tauriBridge();
  return bridge === undefined ? new WebShell() : new TauriShell(bridge);
}

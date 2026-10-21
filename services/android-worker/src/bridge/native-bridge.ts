import type {
  AndroidApp,
  AndroidAppController,
  AndroidBatteryState,
  AndroidDeviceInspector,
  AndroidNotificationController,
  AndroidPlatform,
  AndroidScreenshotProvider,
  AndroidUiController,
  ScrollDirection,
  Screenshot,
  UiNode,
  UiSelector,
} from "../ports.js";
import type { CredentialSigner } from "@nexus/worker-core";

/**
 * Adaptateur vers le module natif Kotlin.
 *
 * Une seule couche de traduction, et rien d'autre : pas de validation, pas de
 * politique, pas de décision. Tout cela s'est déjà produit en amont, dans du
 * code testable. Ce fichier ne fait qu'appeler.
 *
 * L'intérêt est de rendre la frontière **explicite et étroite**. `NexusNative`
 * ci-dessous est la liste exhaustive de ce que le code JavaScript peut demander
 * au système Android. Il n'y a pas de méthode générique, pas d'`invoke(nom,
 * args)`, pas d'exécution d'`Intent` arbitraire — ajouter un pouvoir au worker
 * exige d'ajouter une méthode ici *et* dans le Kotlin, ce qui se voit en revue.
 */

/**
 * Le module natif, tel que React Native l'expose.
 *
 * Les méthodes renvoient des `Promise` : c'est la forme qu'impose le pont, et
 * chacune correspond à une méthode `@ReactMethod` du Kotlin.
 */
export interface NexusNative {
  // Applications
  listApps(): Promise<AndroidApp[]>;
  openApp(packageName: string): Promise<{ launched: boolean; reason?: string }>;
  isInstalled(packageName: string): Promise<boolean>;

  // Accessibilité
  isAccessibilityEnabled(): Promise<boolean>;
  findNode(selectorJson: string): Promise<UiNode | null>;
  click(selectorJson: string): Promise<{ clicked: boolean }>;
  inputText(selectorJson: string, text: string): Promise<{ entered: boolean; characters: number }>;
  scroll(direction: string, amount: number): Promise<{ scrolled: boolean }>;

  // Capture
  isScreenshotAvailable(): Promise<boolean>;
  takeScreenshot(maxDimension: number): Promise<Screenshot>;

  // Notifications — émission seule
  canPostNotifications(): Promise<boolean>;
  postNotification(
    title: string,
    body: string,
    channelId: string,
  ): Promise<{ posted: boolean; notificationId: number }>;

  // Appareil
  batteryState(): Promise<AndroidBatteryState>;
  sdkVersion(): Promise<number>;

  /**
   * Signe un nonce avec la clé du magasin de clés d'Android.
   *
   * La clé privée ne quitte jamais le magasin — l'application ne la lit pas,
   * elle demande une signature. Sur un appareil doté d'une enclave, la clé n'est
   * même pas extractible par le système.
   */
  signChallenge(keyAlias: string, nonce: string): Promise<string>;

  /**
   * Clé **publique** de l'appareil, au format PEM. Créée si elle n'existe pas.
   *
   * C'est la moitié publiable de la paire : elle ne signe rien, elle vérifie. Le
   * cœur en a besoin pour valider les défis de cet appareil, et il n'existe
   * aucun autre moyen de la lui donner — la clé privée est née dans le magasin
   * et n'en sortira pas.
   */
  devicePublicKeyPem(keyAlias: string): Promise<string>;

  /**
   * Octets aléatoires cryptographiques, encodés en base64.
   *
   * Appel **synchrone** sur le pont : `randomFillSync` du code partagé l'est, et
   * le moteur JavaScript d'Android n'offre aucune source sûre. Voir
   * `shim/node-crypto.js`, qui est le seul appelant.
   *
   * Elle ne touche pas au téléphone : elle ne lit rien, n'affiche rien, ne
   * démarre rien. Elle n'élargit donc pas ce que NEXUS peut faire à l'appareil.
   */
  secureRandomBase64(count: number): string;
}

/** Configuration publique persistée après consommation du ticket. */
export interface NexusProvisioningNative {
  loadProvisioning(): Promise<{ apiUrl: string; deviceId: string } | null>;
  saveProvisioning(apiUrl: string, deviceId: string): Promise<void>;
}

/**
 * Annule une opération native.
 *
 * Le pont React Native ne transporte pas d'`AbortSignal` : le Kotlin ne peut pas
 * observer l'annulation directement. On la traite donc du côté JavaScript — la
 * promesse est abandonnée dès que le signal se déclenche, et le résultat tardif
 * est ignoré.
 *
 * Ce n'est pas une annulation parfaite : l'appui a peut-être déjà eu lieu sur le
 * téléphone. C'est une limite honnête d'Android et du pont, documentée comme
 * telle, et non un défaut qu'on masquerait.
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal, capability: string): Promise<T> {
  if (!signal.aborted && signal.onabort === null) {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new AbortError(capability));
          },
          { once: true },
        );
      }),
    ]);
  }

  if (signal.aborted) return Promise.reject(new AbortError(capability));
  return promise;
}

class AbortError extends Error {
  constructor(capability: string) {
    super(`${capability} annulée`);
    this.name = "AbortError";
  }
}

class NativeAppController implements AndroidAppController {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  listApps(): Promise<AndroidApp[]> {
    return this.#native.listApps();
  }

  openApp(packageName: string): Promise<{ launched: boolean; reason?: string }> {
    return this.#native.openApp(packageName);
  }

  isInstalled(packageName: string): Promise<boolean> {
    return this.#native.isInstalled(packageName);
  }
}

class NativeUiController implements AndroidUiController {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  isAccessibilityEnabled(): Promise<boolean> {
    return this.#native.isAccessibilityEnabled();
  }

  async findNode(selector: UiSelector): Promise<UiNode | undefined> {
    const node = await this.#native.findNode(JSON.stringify(selector));
    return node ?? undefined;
  }

  click(selector: UiSelector, signal: AbortSignal): Promise<{ clicked: boolean }> {
    return withAbort(this.#native.click(JSON.stringify(selector)), signal, "android.ui.click");
  }

  inputText(
    selector: UiSelector,
    text: string,
    signal: AbortSignal,
  ): Promise<{ entered: boolean; characters: number }> {
    return withAbort(
      this.#native.inputText(JSON.stringify(selector), text),
      signal,
      "android.ui.input",
    );
  }

  scroll(
    direction: ScrollDirection,
    amount: number,
    signal: AbortSignal,
  ): Promise<{ scrolled: boolean }> {
    return withAbort(this.#native.scroll(direction, amount), signal, "android.ui.scroll");
  }
}

class NativeScreenshotProvider implements AndroidScreenshotProvider {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  isAvailable(): Promise<boolean> {
    return this.#native.isScreenshotAvailable();
  }

  capture(maxDimension: number, signal: AbortSignal): Promise<Screenshot> {
    return withAbort(this.#native.takeScreenshot(maxDimension), signal, "android.ui.screenshot");
  }
}

class NativeNotificationController implements AndroidNotificationController {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  canPostNotifications(): Promise<boolean> {
    return this.#native.canPostNotifications();
  }

  notify(input: {
    title: string;
    body: string;
    channelId: string;
  }): Promise<{ posted: boolean; notificationId: number }> {
    return this.#native.postNotification(input.title, input.body, input.channelId);
  }
}

class NativeDeviceInspector implements AndroidDeviceInspector {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  batteryState(): Promise<AndroidBatteryState> {
    return this.#native.batteryState();
  }

  sdkVersion(): Promise<number> {
    return this.#native.sdkVersion();
  }
}

/**
 * Signataire adossé au magasin de clés d'Android.
 *
 * **Android ne gère pas Ed25519 dans son magasin de clés.** La clé de l'appareil
 * est donc une clé ECDSA P-256, non extractible, éventuellement conservée dans
 * l'enclave sécurisée du téléphone. Le cœur la vérifie avec `ecdsaP256Verifier`.
 *
 * Le compromis est explicite : une clé Ed25519 logicielle serait cohérente avec
 * les autres appareils mais lisible par quiconque obtient les fichiers de
 * l'application ; une clé P-256 matérielle résiste à l'extraction. On préfère la
 * résistance à l'uniformité.
 */
export class KeystoreCredentialSigner implements CredentialSigner {
  readonly #native: NexusNative;
  readonly #keyAlias: string;

  constructor(native: NexusNative, keyAlias: string) {
    this.#native = native;
    this.#keyAlias = keyAlias;
  }

  sign(nonce: string): Promise<string> {
    return this.#native.signChallenge(this.#keyAlias, nonce);
  }
}

/** Construit les quatre ports Android à partir du module natif. */
export function createAndroidPlatform(native: NexusNative): AndroidPlatform {
  return {
    apps: new NativeAppController(native),
    ui: new NativeUiController(native),
    screenshots: new NativeScreenshotProvider(native),
    notifications: new NativeNotificationController(native),
    device: new NativeDeviceInspector(native),
  };
}

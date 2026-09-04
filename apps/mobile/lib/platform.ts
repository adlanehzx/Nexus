import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import type {
  HttpClient,
  HttpResponse,
  NetworkMonitor,
  SecureStorage,
  SocketState,
  SocketTransport,
  SpeechToTextProvider,
  TextToSpeechProvider,
  TranscriptionResult,
} from "@nexus/client-core";

/**
 * Les cinq ports de `@nexus/client-core`, implémentés pour iOS.
 *
 * Ce fichier ne contient **aucune décision** : session, reconnexion, état,
 * pipeline vocal vivent dans le cœur client, qui est testé. Ici on ne fait que
 * combler les trous que la plateforme seule peut combler.
 *
 * C'est le même découpage que pour les workers Windows et Android, et pour la
 * même raison : ce qui touche au système ne se teste pas ici, donc on en met le
 * moins possible.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Trousseau
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trousseau iOS.
 *
 * `expo-secure-store` s'appuie sur le Keychain : chiffré par le système, lié à
 * l'appareil, inaccessible aux autres applications.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` est délibéré. « This device only » exclut la
 * clé des sauvegardes iCloud : un jeton NEXUS ne doit pas se retrouver sur un
 * autre téléphone via une restauration. « When unlocked » interdit la lecture
 * écran verrouillé — le client n'en a pas besoin, il n'agit que quand
 * l'utilisateur regarde.
 *
 * **Jamais `AsyncStorage`** : il écrit en clair dans le bac à sable, qu'une
 * sauvegarde non chiffrée exporte tel quel.
 */
export class KeychainStorage implements SecureStorage {
  readonly #options: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };

  async get(key: string): Promise<string | undefined> {
    const value = await SecureStore.getItemAsync(key, this.#options);
    return value ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value, this.#options);
  }

  async remove(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key, this.#options);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Réseau
// ─────────────────────────────────────────────────────────────────────────────

export class FetchHttpClient implements HttpClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(input: Parameters<HttpClient["request"]>[0]): Promise<HttpResponse> {
    const response = await fetch(`${this.#baseUrl}${input.path}`, {
      method: input.method,
      headers: {
        "content-type": "application/json",
        ...input.headers,
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    // Une réponse sans corps JSON — 204, ou une erreur d'infrastructure — ne
    // doit pas faire échouer l'appelant sur une exception d'analyse.
    const body: unknown = await response.json().catch(() => null);

    return { status: response.status, body };
  }
}

/**
 * WebSocket natif.
 *
 * React Native fournit `WebSocket` ; il ne manque que la mise en forme du port.
 * Le jeton voyage dans la **première trame**, pas dans l'URL : une URL finit
 * dans les journaux de proxy et dans l'historique de connexion.
 */
export class NativeSocket implements SocketTransport {
  #socket: WebSocket | undefined;
  #state: SocketState = "idle";
  #onMessage: ((data: string) => void) | undefined;
  #onClose: ((reason: string, code?: number) => void) | undefined;

  get state(): SocketState {
    return this.#state;
  }

  connect(url: string): Promise<void> {
    this.#state = "connecting";

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.#socket = socket;

      socket.onopen = () => {
        this.#state = "open";
        resolve();
      };

      socket.onerror = () => {
        // `onerror` puis `onclose` : on rejette ici et on laisse `onclose`
        // notifier la fermeture, sans double signalement.
        if (this.#state === "connecting") reject(new Error("connexion impossible"));
      };

      socket.onmessage = (event: { data: unknown }) => {
        if (typeof event.data === "string") this.#onMessage?.(event.data);
      };

      // Le code de fermeture accompagne la raison : c'est lui qui dit au cœur
      // client si la session a été refusée — auquel cas il fait tourner le
      // jeton — ou si le réseau a simplement coupé.
      socket.onclose = (event: { reason?: string; code?: number }) => {
        this.#state = "closed";
        this.#onClose?.(event.reason ?? "socket fermée", event.code);
      };
    });
  }

  send(data: string): void {
    this.#socket?.send(data);
  }

  close(reason: string): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#socket?.close(1000, reason);
  }

  onMessage(handler: (data: string) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string, code?: number) => void): void {
    this.#onClose = handler;
  }
}

/**
 * État du réseau.
 *
 * Volontairement minimal — pas de `@react-native-community/netinfo`. Une
 * dépendance native de plus pour une information qu'on obtient déjà en observant
 * les échecs de connexion n'en vaut pas le coût. Le jour où la distinction
 * « pas de réseau » / « serveur muet » devient importante à l'usage, elle
 * s'ajoutera derrière ce même port.
 */
export class OptimisticNetworkMonitor implements NetworkMonitor {
  #online = true;
  #handler: ((online: boolean) => void) | undefined;

  isOnline(): boolean {
    return this.#online;
  }

  onChange(handler: (online: boolean) => void): void {
    this.#handler = handler;
  }

  /** Appelé par la couche réseau quand une connexion échoue ou aboutit. */
  report(online: boolean): void {
    if (this.#online === online) return;
    this.#online = online;
    this.#handler?.(online);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Voix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthèse vocale iOS, via `expo-speech`.
 *
 * `stop()` est appelé avant chaque énoncé : deux réponses qui se chevauchent
 * sont incompréhensibles, et l'utilisateur n'a aucun moyen de démêler.
 */
export class ExpoTextToSpeech implements TextToSpeechProvider {
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async speak(text: string, options?: { locale?: string; rate?: number }): Promise<void> {
    await Speech.stop();

    return new Promise<void>((resolve, reject) => {
      Speech.speak(text, {
        language: options?.locale ?? "fr-FR",
        rate: options?.rate ?? 1,
        onDone: () => {
          resolve();
        },
        onStopped: () => {
          resolve();
        },
        onError: () => {
          reject(new Error("synthèse vocale indisponible"));
        },
      });
    });
  }

  async stop(): Promise<void> {
    await Speech.stop();
  }

  isSpeaking(): Promise<boolean> {
    return Speech.isSpeakingAsync();
  }
}

/**
 * Reconnaissance vocale.
 *
 * **Non implémentée.** `expo-speech` synthétise, il ne transcrit pas ; la
 * reconnaissance sur iOS demande `SFSpeechRecognizer`, donc un module natif.
 *
 * Ce substitut annonce honnêtement son indisponibilité plutôt que de faire
 * croire à un micro qui marche : `isAvailable()` répond `false`, le pipeline
 * lève `MicrophoneUnavailableError`, et l'interface grise le bouton en
 * expliquant pourquoi. Un bouton qui ne fait rien est pire qu'un bouton absent.
 *
 * Le jour où le module natif existe, il remplace cette classe sans que rien
 * d'autre ne bouge — c'est l'intérêt du port.
 */
export class UnavailableSpeechToText implements SpeechToTextProvider {
  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  requestPermission(): Promise<boolean> {
    return Promise.resolve(false);
  }

  start(): Promise<void> {
    return Promise.reject(new Error("reconnaissance vocale non disponible"));
  }

  stop(): Promise<TranscriptionResult> {
    return Promise.resolve({ text: "" });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

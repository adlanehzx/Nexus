/**
 * Ce qu'une plateforme doit fournir au client NEXUS.
 *
 * Cinq ports, et rien d'autre. Tout le reste — session, reconnexion, état,
 * pipeline vocal, corrélation des demandes — est du TypeScript ordinaire qui
 * tourne aussi bien sous Node que sur Hermes.
 *
 * C'est ce qui rend le client **testable sans simulateur iOS**. Un écran se
 * relit ; une machine à états de reconnexion ne se relit pas, elle s'éprouve.
 * Le découpage met donc la totalité de la logique du côté vérifiable.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Stockage des secrets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coffre local.
 *
 * Sur iOS, c'est le trousseau — chiffré par le système, lié à l'appareil, et
 * inaccessible aux autres applications. **Jamais `AsyncStorage`** : il écrit en
 * clair dans le bac à sable de l'application, qu'une sauvegarde iTunes non
 * chiffrée exporte tel quel.
 *
 * Les méthodes sont asynchrones parce que le trousseau l'est.
 */
export interface SecureStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Réseau
// ─────────────────────────────────────────────────────────────────────────────

/** Réponse HTTP, réduite à ce dont le client a besoin. */
export interface HttpResponse {
  status: number;
  body: unknown;
}

/**
 * Client HTTP.
 *
 * Port plutôt qu'un appel direct à `fetch` : les tests décrivent des réponses
 * sans serveur, et une implémentation native peut ajouter l'épinglage de
 * certificat sans toucher à la logique.
 */
export interface HttpClient {
  request(input: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<HttpResponse>;
}

export type SocketState = "idle" | "connecting" | "open" | "closed";

/**
 * Socket temps réel.
 *
 * Volontairement plus pauvre que l'API WebSocket du navigateur : `connect`,
 * `send`, `close`, deux abonnements. Le client n'a pas besoin du reste, et
 * l'implémentation React Native n'a qu'à combler ces cinq trous.
 */
export interface SocketTransport {
  readonly state: SocketState;
  connect(url: string): Promise<void>;
  send(data: string): void;
  close(reason: string): void;
  onMessage(handler: (data: string) => void): void;
  /**
   * Fermeture, subie ou demandée.
   *
   * Le `code` est celui de la trame de fermeture WebSocket quand la plateforme
   * le fournit. Il ne sert pas à décorer un message : c'est lui qui distingue
   * « le réseau a coupé » de « le cœur a refusé la session », et les deux
   * n'appellent pas la même reprise.
   */
  onClose(handler: (reason: string, code?: number) => void): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Voix
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  /** Confiance de 0 à 1, quand la plateforme la fournit. */
  confidence?: number;
}

/**
 * Reconnaissance vocale.
 *
 * **Il n'existe pas d'écoute permanente.** Le port n'expose que `start` et
 * `stop` : l'utilisateur appuie, parle, relâche. Aucune méthode ne permet de
 * démarrer une écoute continue, et c'est délibéré — une API qui ne le propose
 * pas ne peut pas être détournée par inadvertance.
 *
 * `onPartial` sert à afficher le texte au fil de la parole ; il ne déclenche
 * jamais d'envoi.
 */
export interface SpeechToTextProvider {
  isAvailable(): Promise<boolean>;
  /** Demande l'autorisation micro. Refus = `false`, jamais une exception. */
  requestPermission(): Promise<boolean>;
  start(options?: { locale?: string; onPartial?: (text: string) => void }): Promise<void>;
  /** Arrête l'écoute et rend la transcription finale. */
  stop(): Promise<TranscriptionResult>;
  /** Abandonne sans transcrire — l'utilisateur a annulé. */
  cancel(): Promise<void>;
}

/**
 * Synthèse vocale.
 *
 * `speak` est **facultatif** dans le flux : la réponse s'affiche toujours, elle
 * ne se prononce que si l'utilisateur l'a demandé. Lire à voix haute dans un
 * lieu public ce qu'un assistant personnel répond est rarement souhaité.
 */
export interface TextToSpeechProvider {
  isAvailable(): Promise<boolean>;
  speak(text: string, options?: { locale?: string; rate?: number }): Promise<void>;
  stop(): Promise<void>;
  isSpeaking(): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Divers
// ─────────────────────────────────────────────────────────────────────────────

/** Minuteries injectables : les tests de reconnexion n'attendent pas réellement. */
export interface TimerPort {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export const systemTimers: TimerPort = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * État de la connexion réseau de l'appareil.
 *
 * Un téléphone passe son temps à perdre le réseau. Distinguer « hors ligne »
 * de « le serveur ne répond pas » change ce qu'on affiche : dans le premier cas
 * l'utilisateur peut agir, dans le second non.
 */
export interface NetworkMonitor {
  isOnline(): boolean;
  onChange(handler: (online: boolean) => void): void;
}

import type {
  NetworkMonitor,
  SocketState,
  SocketTransport,
  SpeechToTextProvider,
  TextToSpeechProvider,
  TranscriptionResult,
} from "@nexus/client-core";

// `FetchHttpClient` vit desormais dans `@nexus/client-core` : trois copies
// identiques dans trois applications finissent toujours par diverger sur un
// detail, et c'est celle qu'on n'a pas relue qui casse.
export { FetchHttpClient } from "@nexus/client-core";

/**
 * Les ports de `@nexus/client-core`, implémentés pour la fenêtre Windows.
 *
 * Même découpage que sur iOS, et pour la même raison : ce qui touche à la
 * plateforme ne se teste pas, donc on en met le moins possible. Session,
 * reconnexion, corrélation des demandes, état — tout cela vit dans le cœur
 * client, qui est éprouvé.
 *
 * Ce fichier ne prend **aucune décision d'autorisation**. Il ne sait pas ce
 * qu'est une tâche, une capacité ou un exécutant. Il ouvre une socket et fait
 * des requêtes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Réseau
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebSocket du moteur de rendu.
 *
 * Le jeton voyage dans la **première trame**, jamais dans l'URL : une URL de
 * WebSocket apparaît dans les journaux de proxy et dans l'historique de
 * connexion, un cadre applicatif non.
 *
 * Le **code** de fermeture est propagé au cœur client. C'est ce qui lui permet
 * de distinguer « le réseau a coupé » de « le cœur a refusé la session », et de
 * faire tourner le jeton dans le second cas plutôt que de reconnecter en boucle
 * avec un secret périmé — le scénario exact d'un poste laissé ouvert la nuit.
 */
export class BrowserSocket implements SocketTransport {
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
        // `onerror` est suivi de `onclose` : on rejette ici, et `onclose`
        // notifie la fermeture. Signaler aux deux endroits ferait compter deux
        // coupures pour une.
        if (this.#state === "connecting") reject(new Error("connexion impossible"));
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") this.#onMessage?.(event.data);
      };

      socket.onclose = (event) => {
        this.#state = "closed";
        this.#onClose?.(event.reason.length > 0 ? event.reason : "socket fermée", event.code);
      };
    });
  }

  send(data: string): void {
    this.#socket?.send(data);
  }

  close(reason: string): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    // 1000 : fermeture normale. Les codes 4xxx sont réservés au serveur.
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
 * État du réseau, tel que le moteur de rendu le voit.
 *
 * `navigator.onLine` est notoirement optimiste — il dit surtout « une interface
 * réseau existe ». Il suffit néanmoins à ce dont le client a besoin : ne pas
 * composer dans le vide quand le câble est débranché. Le reste — un serveur
 * joignable mais muet — se détecte par l'échec de connexion, pas par le
 * navigateur.
 */
export class BrowserNetworkMonitor implements NetworkMonitor {
  #handler: ((online: boolean) => void) | undefined;

  constructor() {
    globalThis.addEventListener("online", () => {
      this.#handler?.(true);
    });
    globalThis.addEventListener("offline", () => {
      this.#handler?.(false);
    });
  }

  isOnline(): boolean {
    return navigator.onLine;
  }

  onChange(handler: (online: boolean) => void): void {
    this.#handler = handler;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Voix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthèse vocale du moteur de rendu.
 *
 * WebView2 est du Chromium : `speechSynthesis` s'y appuie sur les voix
 * installées dans Windows, hors ligne et sans service tiers.
 */
export class WebTextToSpeech implements TextToSpeechProvider {
  isAvailable(): Promise<boolean> {
    return Promise.resolve("speechSynthesis" in globalThis);
  }

  speak(text: string, options?: { locale?: string; rate?: number }): Promise<void> {
    // Deux réponses qui se chevauchent sont incompréhensibles, et l'utilisateur
    // n'a aucun moyen de démêler.
    globalThis.speechSynthesis.cancel();

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = options?.locale ?? "fr-FR";
      utterance.rate = options?.rate ?? 1;
      utterance.onend = () => {
        resolve();
      };
      utterance.onerror = () => {
        reject(new Error("synthèse vocale indisponible"));
      };
      globalThis.speechSynthesis.speak(utterance);
    });
  }

  stop(): Promise<void> {
    globalThis.speechSynthesis.cancel();
    return Promise.resolve();
  }

  isSpeaking(): Promise<boolean> {
    return Promise.resolve(globalThis.speechSynthesis.speaking);
  }
}

/**
 * Forme minimale de l'API de reconnaissance vocale du moteur de rendu.
 *
 * Déclarée ici plutôt qu'importée : `SpeechRecognition` ne figure pas dans les
 * types DOM standard, parce que l'API n'est pas normalisée. On décrit donc ce
 * qu'on utilise, et rien de plus.
 */
interface WebSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: WebSpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface WebSpeechResultEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string; confidence: number } };
  };
}

type RecognitionConstructor = new () => WebSpeechRecognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const scope = globalThis as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/**
 * Reconnaissance vocale du moteur de rendu.
 *
 * **Pas d'écoute permanente.** `continuous` est mis à `false` et le port lui-même
 * n'offre que `start` / `stop` / `cancel` : l'utilisateur maintient le bouton, il
 * parle, il relâche. Aucun chemin de ce fichier ne démarre une écoute que
 * l'utilisateur n'a pas déclenchée.
 *
 * L'API n'étant pas normalisée, sa présence est détectée à l'exécution. Quand
 * elle manque, on l'annonce (`isAvailable() === false`) et l'interface grise le
 * micro en disant pourquoi — plutôt que d'offrir un bouton qui ne fait rien.
 */
export class WebSpeechToText implements SpeechToTextProvider {
  #recognition: WebSpeechRecognition | undefined;
  #transcript = "";
  #confidence: number | undefined;
  #ended: Promise<void> | undefined;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(recognitionConstructor() !== undefined);
  }

  /**
   * Autorisation micro.
   *
   * `getUserMedia` déclenche la demande système, puis la piste est **coupée
   * immédiatement** : on voulait l'autorisation, pas le flux. Un micro laissé
   * ouvert allume la diode d'enregistrement sans que rien n'écoute.
   */
  async requestPermission(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch {
      return false;
    }
  }

  start(options?: { locale?: string; onPartial?: (text: string) => void }): Promise<void> {
    const Recognition = recognitionConstructor();
    if (Recognition === undefined) {
      return Promise.reject(new Error("reconnaissance vocale non disponible"));
    }

    const recognition = new Recognition();
    recognition.lang = options?.locale ?? "fr-FR";
    recognition.continuous = false;
    recognition.interimResults = true;

    this.#transcript = "";
    this.#confidence = undefined;
    this.#recognition = recognition;

    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result === undefined) continue;

        if (result.isFinal) {
          this.#transcript += result[0].transcript;
          this.#confidence = result[0].confidence;
        } else {
          options?.onPartial?.(this.#transcript + result[0].transcript);
        }
      }
    };

    // Le moteur signale la fin de façon asynchrone : `stop()` doit l'attendre,
    // sinon la transcription rendue serait tronquée du dernier mot.
    this.#ended = new Promise<void>((resolve) => {
      recognition.onend = () => {
        resolve();
      };
      recognition.onerror = () => {
        resolve();
      };
    });

    recognition.start();
    return Promise.resolve();
  }

  async stop(): Promise<TranscriptionResult> {
    this.#recognition?.stop();
    await this.#ended;
    this.#recognition = undefined;

    return {
      text: this.#transcript.trim(),
      ...(this.#confidence === undefined ? {} : { confidence: this.#confidence }),
    };
  }

  async cancel(): Promise<void> {
    this.#recognition?.abort();
    await this.#ended;
    this.#recognition = undefined;
    this.#transcript = "";
  }
}

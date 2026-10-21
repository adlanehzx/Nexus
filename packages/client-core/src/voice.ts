import { AppError, type ErrorSeverity } from "@nexus/shared";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./ports.js";

/**
 * Le pipeline vocal.
 *
 *     micro (appui) → reconnaissance → texte → NEXUS → réponse → (voix)
 *
 * **Il n'existe pas d'écoute permanente**, et ce n'est pas un oubli à combler
 * plus tard. Le port de reconnaissance n'expose que `start`, `stop` et `cancel` :
 * une API qui ne propose pas l'écoute continue ne peut pas être détournée par
 * inadvertance, ni par une future modification distraite.
 *
 * Trois gardes découlent du même principe — le micro d'un téléphone personnel
 * n'écoute que quand son propriétaire le décide :
 *
 *  1. l'écoute démarre sur un **geste explicite**, jamais sur un événement ;
 *  2. elle s'arrête au relâchement, ou au plafond de durée ;
 *  3. l'annulation jette la transcription **sans l'envoyer**.
 *
 * La lecture à voix haute est **facultative** et désactivée par défaut : lire
 * dans un lieu public ce qu'un assistant personnel répond est rarement voulu.
 */

export class MicrophoneUnavailableError extends AppError {
  readonly code = "MICROPHONE_UNAVAILABLE";
  readonly httpStatus = 403;
  override readonly severity: ErrorSeverity = "warning";

  constructor(reason: string) {
    super({
      message: `Micro indisponible : ${reason}`,
      userMessage:
        "NEXUS has no access to the microphone. Allow it in Settings → NEXUS → Microphone.",
      context: { reason },
    });
  }
}

export type VoiceState = "idle" | "listening" | "transcribing" | "speaking";

export interface VoicePipelineOptions {
  speechToText: SpeechToTextProvider;
  textToSpeech: TextToSpeechProvider;
  /**
   * Durée maximale d'une écoute.
   *
   * Un garde-fou, pas une fonctionnalité : si l'interface oublie d'appeler
   * `stop` — écran verrouillé, application suspendue — le micro ne doit pas
   * rester ouvert. Trente secondes couvrent largement une phrase.
   */
  maxListeningMs?: number;
  locale?: string;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onStateChange?: (state: VoiceState) => void;
  onPartial?: (text: string) => void;
}

export class VoicePipeline {
  readonly #stt: SpeechToTextProvider;
  readonly #tts: TextToSpeechProvider;
  readonly #maxListeningMs: number;
  readonly #locale: string | undefined;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #onStateChange: ((state: VoiceState) => void) | undefined;
  readonly #onPartial: ((text: string) => void) | undefined;

  #state: VoiceState = "idle";
  #guardHandle: unknown;

  /** La lecture à voix haute est un choix de l'utilisateur, pas un défaut. */
  #speakReplies = false;

  constructor(options: VoicePipelineOptions) {
    this.#stt = options.speechToText;
    this.#tts = options.textToSpeech;
    this.#maxListeningMs = options.maxListeningMs ?? 30_000;
    this.#locale = options.locale;
    this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.#onStateChange = options.onStateChange;
    this.#onPartial = options.onPartial;
  }

  get state(): VoiceState {
    return this.#state;
  }

  get isListening(): boolean {
    return this.#state === "listening";
  }

  get speakRepliesEnabled(): boolean {
    return this.#speakReplies;
  }

  setSpeakReplies(enabled: boolean): void {
    this.#speakReplies = enabled;
  }

  /**
   * La plateforme sait-elle transcrire ?
   *
   * Interrogé au démarrage pour griser le micro **avec une explication** plutôt
   * que de le proposer et d'échouer au moment où l'utilisateur parle. Un bouton
   * qui ne fait rien est pire qu'un bouton absent : il fait douter du reste.
   */
  isSpeechAvailable(): Promise<boolean> {
    return this.#stt.isAvailable();
  }

  /**
   * Démarre l'écoute, sur geste explicite de l'utilisateur.
   *
   * @throws {MicrophoneUnavailableError} si le matériel manque ou si
   *   l'autorisation est refusée. Les deux cas sont distingués dans le contexte :
   *   « pas de micro » n'appelle pas la même action que « autorisation refusée ».
   */
  async startListening(): Promise<void> {
    if (this.#state === "listening") return;

    if (!(await this.#stt.isAvailable())) {
      throw new MicrophoneUnavailableError("reconnaissance vocale indisponible");
    }
    if (!(await this.#stt.requestPermission())) {
      throw new MicrophoneUnavailableError("autorisation refusée");
    }

    await this.#stt.start({
      ...(this.#locale === undefined ? {} : { locale: this.#locale }),
      ...(this.#onPartial === undefined ? {} : { onPartial: this.#onPartial }),
    });

    this.#setState("listening");

    // Filet de sécurité : le micro ne reste jamais ouvert parce qu'un écran
    // s'est verrouillé au mauvais moment.
    this.#guardHandle = this.#setTimer(() => {
      void this.cancelListening();
    }, this.#maxListeningMs);
  }

  /**
   * Arrête l'écoute et rend le texte reconnu.
   *
   * Retourne `undefined` quand rien d'exploitable n'a été dit : c'est le cas
   * ordinaire d'un appui accidentel, et envoyer une chaîne vide à l'assistant
   * n'aurait aucun sens.
   */
  async stopListening(): Promise<string | undefined> {
    if (this.#state !== "listening") return undefined;

    this.#clearGuard();
    this.#setState("transcribing");

    try {
      const result = await this.#stt.stop();
      const text = result.text.trim();

      return text.length === 0 ? undefined : text;
    } finally {
      this.#setState("idle");
    }
  }

  /**
   * Abandonne l'écoute.
   *
   * Rien n'est transcrit, rien n'est envoyé. L'utilisateur a changé d'avis, et
   * ce qu'il a dit ne doit aller nulle part.
   */
  async cancelListening(): Promise<void> {
    if (this.#state !== "listening") return;

    this.#clearGuard();
    await this.#stt.cancel().catch(() => undefined);
    this.#setState("idle");
  }

  /**
   * Lit une réponse à voix haute, si l'utilisateur l'a demandé.
   *
   * Ne lève pas quand la synthèse échoue : la réponse est déjà affichée, et
   * faire échouer l'affichage parce que le haut-parleur refuse serait absurde.
   */
  async speak(text: string): Promise<boolean> {
    if (!this.#speakReplies) return false;
    if (!(await this.#tts.isAvailable())) return false;

    this.#setState("speaking");
    try {
      await this.#tts.speak(text, {
        ...(this.#locale === undefined ? {} : { locale: this.#locale }),
      });
      return true;
    } catch {
      return false;
    } finally {
      this.#setState("idle");
    }
  }

  /** Interrompt la lecture — l'utilisateur veut reprendre la parole. */
  async stopSpeaking(): Promise<void> {
    await this.#tts.stop().catch(() => undefined);
    if (this.#state === "speaking") this.#setState("idle");
  }

  #clearGuard(): void {
    if (this.#guardHandle === undefined) return;
    this.#clearTimer(this.#guardHandle);
    this.#guardHandle = undefined;
  }

  #setState(state: VoiceState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onStateChange?.(state);
  }
}

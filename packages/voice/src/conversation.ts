import type { ClockPort } from "./ports.js";
import type { PiperSpeech } from "./piper.js";
import type { TranscriptionResult, WhisperDictation } from "./whisper.js";

/**
 * Conversation mains libres.
 *
 * ## Ce que « mains libres » veut dire ici, et ne veut pas dire
 *
 * Un tour : on écoute, on transcrit, on répond, on prononce, on réécoute. Sans
 * toucher l'appareil **entre** les tours.
 *
 * Ce que ça ne veut pas dire : une écoute permanente. La conversation démarre
 * sur un geste explicite et s'arrête d'elle-même — après un silence, après un
 * plafond de tours, après un plafond de durée. Un assistant qui resterait à
 * l'écoute « au cas où » est précisément ce que NEXUS refuse d'être, et aucune
 * méthode ici ne permet de le construire.
 *
 * ## L'interruption vocale
 *
 * Pendant que NEXUS parle, le micro reste écouté. Si la personne parle, la
 * synthèse est coupée **immédiatement** et son tour commence. C'est la
 * différence entre une conversation et un répondeur : on peut couper la parole.
 *
 * La détection n'est pas un modèle de VAD maison — elle est déléguée au port
 * `onSpeechDetected`, parce que la manière de savoir « quelqu'un parle » dépend
 * de la plateforme, et qu'un seuil d'énergie écrit ici serait faux partout.
 */

export interface ConversationTurn {
  /** Ce que la personne a dit. */
  heard: string;
  /** Ce que NEXUS a répondu. */
  answered: string;
  /** La réponse a-t-elle été coupée par la personne ? */
  interrupted: boolean;
}

export interface HandsFreeOptions {
  dictation: WhisperDictation;
  speech: PiperSpeech;
  clock: ClockPort;
  /** Ce que NEXUS répond. C'est l'agent, injecté. */
  answer: (heard: string) => Promise<string>;
  /**
   * Durée d'écoute d'un tour.
   *
   * Un tour qui n'aurait pas de fin obligerait la personne à dire « terminé »,
   * c'est-à-dire à parler à une machine au lieu de parler.
   */
  turnMs?: number;
  /** Plafond de tours. Une conversation sans fin finit par être une écoute permanente. */
  maxTurns?: number;
  /** Plafond de durée totale. Même raison. */
  maxDurationMs?: number;
  /**
   * Signale que la personne parle pendant que NEXUS parle.
   *
   * Absent, l'interruption vocale est désactivée : mieux vaut pas
   * d'interruption qu'une interruption qui se déclenche sur le bruit du
   * ventilateur et coupe chaque phrase.
   */
  onSpeechDetected?: (listener: () => void) => () => void;
  onTurn?: (turn: ConversationTurn) => void;
}

export type ConversationStop = "demandée" | "silence" | "plafond-de-tours" | "plafond-de-durée";

export class HandsFreeConversation {
  readonly #options: HandsFreeOptions;
  readonly #turnMs: number;
  readonly #maxTurns: number;
  readonly #maxDurationMs: number;
  #running = false;
  #stopRequested = false;

  constructor(options: HandsFreeOptions) {
    this.#options = options;
    this.#turnMs = options.turnMs ?? 8_000;
    this.#maxTurns = options.maxTurns ?? 20;
    this.#maxDurationMs = options.maxDurationMs ?? 10 * 60_000;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Arrête après le tour en cours. */
  stop(): void {
    this.#stopRequested = true;
  }

  async run(): Promise<{ turns: ConversationTurn[]; stoppedBy: ConversationStop }> {
    const { dictation, speech, clock, answer, onSpeechDetected, onTurn } = this.#options;
    const startedAt = clock.now();
    const turns: ConversationTurn[] = [];
    this.#running = true;
    this.#stopRequested = false;

    try {
      for (;;) {
        if (this.#stopRequested) return { turns, stoppedBy: "demandée" };
        if (turns.length >= this.#maxTurns) return { turns, stoppedBy: "plafond-de-tours" };
        if (clock.now() - startedAt >= this.#maxDurationMs) {
          return { turns, stoppedBy: "plafond-de-durée" };
        }

        await dictation.start();
        await clock.sleep(this.#turnMs);
        const heard: TranscriptionResult = await dictation.stop();

        // Un silence termine la conversation. C'est la sortie naturelle : on
        // s'arrête de parler, et ça s'arrête — sans formule magique.
        if (heard.text.length === 0) return { turns, stoppedBy: "silence" };

        const answered = await answer(heard.text);

        // L'interruption est armée **avant** de parler, et désarmée après : une
        // détection qui survivrait au tour couperait le tour suivant.
        const disarm = onSpeechDetected?.(() => {
          void speech.stop();
        });
        try {
          await speech.speak(answered);
        } finally {
          disarm?.();
        }

        const turn: ConversationTurn = {
          heard: heard.text,
          answered,
          interrupted: speech.interrupted,
        };
        turns.push(turn);
        onTurn?.(turn);
      }
    } finally {
      this.#running = false;
      // Quoi qu'il arrive, le micro se ferme et la parole s'arrête. Une sortie
      // par exception ne doit pas laisser un micro ouvert.
      await dictation.cancel();
      await speech.stop();
    }
  }
}

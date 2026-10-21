import type { ClockPort } from "./ports.js";
import type { PiperSpeech } from "./piper.js";
import type { TranscriptionResult, WhisperDictation } from "./whisper.js";

/**
 * Hands-free conversational loop.
 *
 * ## Principles
 *
 * Each turn listens, transcribes, queries the agent, speaks the response,
 * and resumes listening without manual device interaction between turns.
 *
 * This is not always-on listening: conversation begins via explicit trigger
 * and terminates automatically upon silence, turn limits, or duration timeouts.
 *
 * ## Barge-in voice interruption
 *
 * While the assistant speaks, microphone input is monitored. If speech is detected,
 * synthesis is cut off immediately and the user turn begins.
 */

export interface ConversationTurn {
  /** What the user said. */
  heard: string;
  /** What NEXUS responded. */
  answered: string;
  /** Whether speech was interrupted by barge-in. */
  interrupted: boolean;
}

export interface HandsFreeOptions {
  dictation: WhisperDictation;
  speech: PiperSpeech;
  clock: ClockPort;
  /** Agent answer handler. */
  answer: (heard: string) => Promise<string>;
  /** Listening duration per turn. */
  turnMs?: number;
  /** Maximum turn count limit. */
  maxTurns?: number;
  /** Maximum total conversation duration limit. */
  maxDurationMs?: number;
  /**
   * Voice activity callback when user speaks while NEXUS is speaking.
   */
  onSpeechDetected?: (listener: () => void) => () => void;
  onTurn?: (turn: ConversationTurn) => void;
}

export type ConversationStop = "requested" | "silence" | "turn-limit" | "duration-limit";

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

  /** Stops conversation after current turn. */
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
        if (this.#stopRequested) return { turns, stoppedBy: "requested" };
        if (turns.length >= this.#maxTurns) return { turns, stoppedBy: "turn-limit" };
        if (clock.now() - startedAt >= this.#maxDurationMs) {
          return { turns, stoppedBy: "duration-limit" };
        }

        await dictation.start();
        await clock.sleep(this.#turnMs);
        const heard: TranscriptionResult = await dictation.stop();

        // Silence naturally terminates the conversation.
        if (heard.text.length === 0) return { turns, stoppedBy: "silence" };

        const answered = await answer(heard.text);

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
      await dictation.cancel();
      await speech.stop();
    }
  }
}

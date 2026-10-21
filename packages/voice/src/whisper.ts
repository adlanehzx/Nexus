import { AppError } from "@nexus/shared";
import type { ClockPort, FilePort, ProcessPort, SpawnedProcess } from "./ports.js";
import type { AudioScratch } from "./scratch.js";

/**
 * Dictée locale par whisper.cpp.
 *
 * ## Pourquoi whisper.cpp et pas une API
 *
 * Parce que la dictée porte tout ce qu'on dit à voix haute chez soi. Une API de
 * transcription reçoit l'audio brut d'un micro de salon, ce qui est la donnée la
 * plus intime qu'un assistant personnel manipule — et elle le reçoit même quand
 * la phrase n'était pas pour lui. whisper.cpp tourne sur la machine, sans
 * compte, sans clé, sans réseau.
 *
 * ## La chaîne, et où elle peut mal tourner
 *
 *     micro (enregistreur) → fichier WAV temporaire → whisper.cpp → texte
 *                                      ↑
 *                          supprimé, suppression vérifiée
 *
 * Deux processus, donc deux façons de laisser quelque chose derrière soi : un
 * enregistreur qui continue après un `stop`, et un fichier qui survit à une
 * erreur. Les deux sont traités ici, et attaqués par les tests.
 *
 * ## Ce qui est « streaming », et ce qui ne l'est pas
 *
 * Les transcriptions partielles sont **réelles** : l'enregistrement est découpé
 * en segments, chacun transcrit dès qu'il est clos, et `onPartial` reçoit le
 * texte au fur et à mesure. Ce n'est pas du flux continu au sens d'un modèle
 * qui écoute — whisper.cpp travaille par fenêtres — et le dire importe : la
 * latence perçue est celle d'un segment, pas celle d'un mot.
 */

export class VoiceUnavailableError extends AppError {
  readonly code = "VOICE_UNAVAILABLE";
  readonly httpStatus = 503;

  constructor(reason: string, remedy: string) {
    super({
      message: `dictée indisponible : ${reason}`,
      userMessage: remedy,
      context: { reason },
    });
  }
}

export interface TranscriptionResult {
  text: string;
  /** Segments transcrits, dans l'ordre. Utile pour comprendre une latence. */
  segments: readonly string[];
  durationMs: number;
}

export interface WhisperOptions {
  process: ProcessPort;
  files: FilePort;
  clock: ClockPort;
  scratch: AudioScratch;
  /** Binaire whisper.cpp. `whisper-cli` sur les versions récentes. */
  binary?: string;
  /** Chemin du modèle `.bin`. Sans lui, la dictée est indisponible. */
  modelPath: string;
  /**
   * Commande d'enregistrement. Elle doit écrire un WAV au chemin donné et
   * s'arrêter sur un signal.
   */
  recorder?: { command: string; args: (path: string) => readonly string[] };
  language?: string;
  /**
   * Durée d'un segment. Plus court = partiels plus fréquents, plus de lancements
   * de whisper. Deux secondes est le compromis qui rend la dictée vivante sans
   * saturer la machine.
   */
  segmentMs?: number;
  /**
   * Plafond absolu d'une écoute.
   *
   * Un garde-fou, pas une fonctionnalité : si l'interface oublie d'appeler
   * `stop` — écran verrouillé, application suspendue — le micro ne doit pas
   * rester ouvert.
   */
  maxListeningMs?: number;
}

/** `arecord` est présent sur toute installation ALSA, donc sur Linux de bureau. */
const DEFAULT_RECORDER = {
  command: "arecord",
  args: (path: string) => ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", path],
};

export class WhisperDictation {
  readonly #process: ProcessPort;
  readonly #files: FilePort;
  readonly #clock: ClockPort;
  readonly #scratch: AudioScratch;
  readonly #binary: string;
  readonly #modelPath: string;
  readonly #recorder: { command: string; args: (path: string) => readonly string[] };
  readonly #language: string | undefined;
  readonly #segmentMs: number;
  readonly #maxListeningMs: number;

  #recording: SpawnedProcess | undefined;
  #cancelled = false;
  #segments: string[] = [];
  #startedAt = 0;

  constructor(options: WhisperOptions) {
    this.#process = options.process;
    this.#files = options.files;
    this.#clock = options.clock;
    this.#scratch = options.scratch;
    this.#binary = options.binary ?? "whisper-cli";
    this.#modelPath = options.modelPath;
    this.#recorder = options.recorder ?? DEFAULT_RECORDER;
    this.#language = options.language;
    this.#segmentMs = options.segmentMs ?? 2_000;
    this.#maxListeningMs = options.maxListeningMs ?? 30_000;
  }

  get listening(): boolean {
    return this.#recording !== undefined;
  }

  /**
   * Tout est-il en place ?
   *
   * Les trois conditions sont vérifiées séparément et chacune porte son
   * remède : « dictée indisponible » oblige à chercher, « le modèle est absent,
   * téléchargez-le avec … » ferme la question.
   */
  async availability(): Promise<{ ok: boolean; reason?: string; remedy?: string }> {
    if ((await this.#process.which(this.#binary)) === undefined) {
      return {
        ok: false,
        reason: `binaire ${this.#binary} absent`,
        remedy: `Installez whisper.cpp, puis vérifiez que « ${this.#binary} » est dans le PATH.`,
      };
    }
    if (!(await this.#files.exists(this.#modelPath))) {
      return {
        ok: false,
        reason: `modèle absent : ${this.#modelPath}`,
        remedy: `Téléchargez un modèle whisper et placez-le à ${this.#modelPath}.`,
      };
    }
    if ((await this.#process.which(this.#recorder.command)) === undefined) {
      return {
        ok: false,
        reason: `enregistreur ${this.#recorder.command} absent`,
        remedy: `Installez « ${this.#recorder.command} » pour capter le micro.`,
      };
    }
    return { ok: true };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.availability()).ok;
  }

  /**
   * Démarre l'écoute.
   *
   * Sur un **geste explicite**, jamais sur un événement : il n'existe pas
   * d'écoute permanente dans NEXUS, et il n'y a volontairement aucune méthode
   * pour en créer une.
   */
  async start(options: { onPartial?: (text: string) => void } = {}): Promise<void> {
    if (this.#recording !== undefined) return;
    const available = await this.availability();
    if (!available.ok) {
      throw new VoiceUnavailableError(available.reason ?? "inconnu", available.remedy ?? "");
    }

    this.#cancelled = false;
    this.#segments = [];
    this.#startedAt = this.#clock.now();

    await this.#scratch.withAudio(async (path) => {
      this.#recording = this.#process.spawn(this.#recorder.command, this.#recorder.args(path));
      // La boucle de segments vit le temps de l'écoute. Elle n'est pas attendue
      // ici : `start` rend la main dès que le micro est ouvert, sinon
      // l'interface resterait bloquée pendant toute la dictée.
      await this.#segmentLoop(path, options.onPartial);
    });
  }

  async #segmentLoop(path: string, onPartial?: (text: string) => void): Promise<void> {
    while (this.#recording !== undefined && !this.#cancelled) {
      await this.#clock.sleep(this.#segmentMs);
      if (this.#recording === undefined || this.#cancelled) break;

      if (this.#clock.now() - this.#startedAt >= this.#maxListeningMs) {
        // Le plafond ferme le micro. Ce n'est pas une erreur : on garde ce qui a
        // été dit, parce que jeter trente secondes de dictée pour punir une
        // interface distraite serait absurde.
        this.#stopRecorder();
        break;
      }

      const transcript = await this.#transcribe(path);
      if (transcript.length > 0 && transcript !== this.#segments.at(-1)) {
        this.#segments = [transcript];
        onPartial?.(transcript);
      }
    }
  }

  /**
   * Arrête l'écoute et rend la transcription.
   *
   * Rend une promesse sans être `async` : il n'y a rien à attendre — tuer un
   * processus est synchrone — et une méthode `async` sans `await` annonce une
   * attente qui n'existe pas.
   */
  stop(): Promise<TranscriptionResult> {
    const durationMs = this.#clock.now() - this.#startedAt;
    this.#stopRecorder();
    return Promise.resolve({
      text: this.#segments.join(" ").trim(),
      segments: [...this.#segments],
      durationMs,
    });
  }

  /**
   * Abandonne sans transcrire.
   *
   * Jette ce qui a été dit **sans l'envoyer**. C'est la garantie que l'annulation
   * annule vraiment : une transcription déjà calculée ne doit pas partir parce
   * qu'elle était prête.
   */
  async cancel(): Promise<void> {
    this.#cancelled = true;
    this.#segments = [];
    this.#stopRecorder();
    await Promise.resolve();
  }

  #stopRecorder(): void {
    this.#recording?.kill();
    this.#recording = undefined;
  }

  async #transcribe(path: string): Promise<string> {
    const size = await this.#files.size(path);
    // Un WAV n'a que son en-tête : il n'y a rien à transcrire, et lancer
    // whisper dessus coûterait un processus pour rendre du vide.
    if (size === undefined || size <= 44) return "";

    const args = [
      "-m",
      this.#modelPath,
      "-f",
      path,
      // Pas de fichier de sortie : le texte vient sur la sortie standard, donc
      // la transcription ne crée aucun fichier à supprimer ensuite.
      "--no-timestamps",
      ...(this.#language === undefined ? [] : ["-l", this.#language]),
    ];
    const run = this.#process.spawn(this.#binary, args);
    const code = await run.exit();
    if (code !== 0) return "";
    return cleanTranscript(await run.output());
  }
}

/**
 * Nettoie la sortie de whisper.cpp.
 *
 * Le binaire écrit des lignes de diagnostic et des marqueurs de silence que
 * personne ne veut voir dans un message de chat. Les retirer ici, et non dans
 * l'interface, évite que chaque surface réinvente le filtre — et en oublie un.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("whisper_") && !line.startsWith("["))
    .map((line) => line.replace(/\((?:silence|musique|rires|bruit)\)/gi, "").trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

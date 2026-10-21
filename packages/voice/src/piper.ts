import type { ProcessPort, SpawnedProcess } from "./ports.js";
import { VoiceUnavailableError } from "./whisper.js";

/**
 * Synthèse vocale locale par Piper.
 *
 * ## Pourquoi locale
 *
 * Même raison que la dictée, dans l'autre sens : lire à voix haute la réponse
 * d'un assistant personnel, c'est prononcer le contenu de ses mails et de son
 * agenda. Une API de synthèse recevrait ce texte-là.
 *
 * ## La chaîne
 *
 *     texte → piper (stdin) → audio brut (stdout) → lecteur (stdin)
 *
 * Deux processus chaînés par un tube, et **aucun fichier** : la synthèse ne
 * laisse rien sur le disque, parce qu'il n'y a rien à laisser. C'est plus
 * simple que la dictée, où whisper exige un fichier d'entrée.
 *
 * ## L'interruption est le sujet
 *
 * Une synthèse qu'on ne peut pas couper est insupportable à l'usage : on parle
 * par-dessus, et la machine continue. `stop()` tue les deux processus, et
 * `interrupted` dit si la phrase a été coupée — ce qui permet à l'appelant de ne
 * pas enchaîner comme si elle avait été entendue.
 */

export interface PiperOptions {
  process: ProcessPort;
  binary?: string;
  /** Modèle de voix `.onnx`. Sans lui, la synthèse est indisponible. */
  modelPath: string;
  /** Lecteur audio. Reçoit le flux brut de Piper sur son entrée standard. */
  player?: { command: string; args: readonly string[] };
  /** Vitesse. Piper l'exprime en « longueur de phonème » : plus petit = plus rapide. */
  lengthScale?: number;
}

/** `aplay` accompagne ALSA, donc présent partout où `arecord` l'est. */
const DEFAULT_PLAYER = {
  command: "aplay",
  // Le format est celui que Piper produit : 16 bits, mono, 22,05 kHz.
  args: ["-q", "-r", "22050", "-f", "S16_LE", "-t", "raw", "-"],
};

export class PiperSpeech {
  readonly #process: ProcessPort;
  readonly #binary: string;
  readonly #modelPath: string;
  readonly #player: { command: string; args: readonly string[] };
  readonly #lengthScale: number | undefined;

  #synthesis: SpawnedProcess | undefined;
  #playback: SpawnedProcess | undefined;
  #interrupted = false;

  constructor(options: PiperOptions) {
    this.#process = options.process;
    this.#binary = options.binary ?? "piper";
    this.#modelPath = options.modelPath;
    this.#player = options.player ?? DEFAULT_PLAYER;
    this.#lengthScale = options.lengthScale;
  }

  get speaking(): boolean {
    return this.#synthesis !== undefined || this.#playback !== undefined;
  }

  /** La dernière phrase a-t-elle été coupée ? */
  get interrupted(): boolean {
    return this.#interrupted;
  }

  async availability(): Promise<{ ok: boolean; reason?: string; remedy?: string }> {
    if ((await this.#process.which(this.#binary)) === undefined) {
      return {
        ok: false,
        reason: `binaire ${this.#binary} absent`,
        remedy: `Installez Piper, puis vérifiez que « ${this.#binary} » est dans le PATH.`,
      };
    }
    if ((await this.#process.which(this.#player.command)) === undefined) {
      return {
        ok: false,
        reason: `lecteur ${this.#player.command} absent`,
        remedy: `Installez « ${this.#player.command} » pour lire l'audio.`,
      };
    }
    return { ok: true };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.availability()).ok;
  }

  /**
   * Prononce un texte, et rend la main quand c'est fini — ou coupé.
   *
   * Ne lève pas si l'audio est coupé : une interruption est le comportement
   * voulu, pas une panne. L'appelant lit `interrupted`.
   */
  async speak(text: string): Promise<{ interrupted: boolean }> {
    const available = await this.availability();
    if (!available.ok) {
      throw new VoiceUnavailableError(available.reason ?? "inconnu", available.remedy ?? "");
    }
    // Une nouvelle phrase remplace la précédente : parler par-dessus soi-même
    // est toujours une erreur.
    await this.stop();
    this.#interrupted = false;

    const args = [
      "--model",
      this.#modelPath,
      // Flux brut sur la sortie standard : aucun fichier intermédiaire, donc
      // aucun fichier à supprimer.
      "--output_raw",
      ...(this.#lengthScale === undefined ? [] : ["--length_scale", String(this.#lengthScale)]),
    ];
    // Références **locales**, et non les champs.
    //
    // Deux réponses peuvent arriver coup sur coup : la seconde appelle `stop()`,
    // qui remet les champs à `undefined` — et la première, réveillée de son
    // `await`, lisait alors `undefined.exit()`. Lire les champs après une
    // attente suppose que personne n'a bougé entre-temps, ce qui est faux dès
    // qu'il y a deux appelants.
    const synthesis = this.#process.spawn(this.#binary, args, text);
    const playback = this.#process.spawn(this.#player.command, this.#player.args);
    this.#synthesis = synthesis;
    this.#playback = playback;

    try {
      await synthesis.exit();
      await playback.exit();
    } finally {
      // Ne nettoyer que si ce sont toujours *nos* processus : sinon on
      // effacerait la trace de la phrase qui nous a remplacés.
      if (this.#synthesis === synthesis) {
        this.#synthesis = undefined;
        this.#playback = undefined;
      }
    }
    return { interrupted: this.#interrupted };
  }

  /**
   * Coupe la parole, tout de suite.
   *
   * Les deux processus sont tués : ne tuer que la synthèse laisserait le lecteur
   * vider son tampon, c'est-à-dire continuer à parler une seconde après qu'on
   * lui a dit de se taire. C'est exactement ce que l'utilisateur perçoit comme
   * « ça ne m'écoute pas ».
   */
  async stop(): Promise<void> {
    if (!this.speaking) return;
    this.#interrupted = true;
    this.#synthesis?.kill();
    this.#playback?.kill();
    this.#synthesis = undefined;
    this.#playback = undefined;
    await Promise.resolve();
  }
}

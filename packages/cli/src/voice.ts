import { homedir } from "node:os";
import { join } from "node:path";
import {
  AudioScratch,
  PiperSpeech,
  WhisperDictation,
  systemClock,
  systemFiles,
  systemProcess,
} from "@nexus/voice";

/**
 * `nexus voice` — vérifier et essayer la voix locale.
 *
 * Deux commandes, et la première est la plus utile :
 *
 *   nexus voice check     ce qui manque, et le geste qui corrige
 *   nexus voice dictate   une dictée réelle, et le texte obtenu
 *
 * `check` existe parce que la voix locale a quatre dépendances externes —
 * whisper.cpp, un modèle, Piper, une voix — et que leur absence se manifeste
 * autrement : par un micro qui s'ouvre et ne rend rien. Une commande qui nomme
 * la pièce manquante remplace une demi-heure de recherche.
 *
 * `dictate` est la seule façon d'être sûr : les tests éprouvent le cycle de vie
 * avec des doublures, parce qu'aucune suite de tests ne peut brancher un micro.
 * La dictée réelle, elle, ne se vérifie qu'en parlant.
 */

export interface VoicePaths {
  model: string;
  voice: string;
  scratch: string;
}

export function voicePaths(home = homedir()): VoicePaths {
  const root = join(home, ".nexus");
  return {
    model: process.env.NEXUS_WHISPER_MODEL ?? join(root, "modeles", "ggml-base.bin"),
    voice: process.env.NEXUS_PIPER_VOICE ?? join(root, "voix", "fr_FR-siwis-medium.onnx"),
    // Hors de `/tmp` partagé : un dossier à nous, en 0700, qu'on peut purger
    // sans se demander à qui appartient le reste.
    scratch: join(root, "audio-temporaire"),
  };
}

function build(paths: VoicePaths) {
  const scratch = new AudioScratch({ files: systemFiles, directory: paths.scratch });
  const dictation = new WhisperDictation({
    process: systemProcess,
    files: systemFiles,
    clock: systemClock,
    scratch,
    modelPath: paths.model,
    language: "fr",
  });
  const speech = new PiperSpeech({ process: systemProcess, modelPath: paths.voice });
  return { dictation, speech };
}

export async function voiceCommand(args: string[]): Promise<number> {
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "check";
  const paths = voicePaths();

  switch (subcommand) {
    case "check":
      return checkVoice(paths);
    case "dictate":
      return dictate(paths, args);
    default:
      process.stderr.write(
        `sous-commande inconnue : ${subcommand}\nusage : nexus voice [check|dictate]\n`,
      );
      return 1;
  }
}

async function checkVoice(paths: VoicePaths): Promise<number> {
  const { dictation, speech } = build(paths);
  process.stdout.write("\nNEXUS — voix locale\n\n");

  const dictationState = await dictation.availability();
  const speechState = await speech.availability();

  const line = (label: string, state: { ok: boolean; reason?: string; remedy?: string }) => {
    process.stdout.write(`  ${state.ok ? "✓" : "✗"} ${label.padEnd(22)}`);
    process.stdout.write(
      state.ok ? "prête\n" : `${state.reason ?? ""}\n      → ${state.remedy ?? ""}\n`,
    );
  };

  line("dictée (whisper.cpp)", dictationState);
  line("synthèse (Piper)", speechState);

  process.stdout.write(`\n  modèle    ${paths.model}\n  voix      ${paths.voice}\n`);
  process.stdout.write(`  audio     ${paths.scratch} (aucun enregistrement conservé)\n\n`);

  if (!dictationState.ok || !speechState.ok) {
    process.stdout.write(
      "  Les deux sont indépendantes : la dictée fonctionne sans la synthèse,\n" +
        "  et NEXUS n'a jamais besoin de parler pour être utilisable.\n\n",
    );
  }
  // La synthèse n'est pas obligatoire : lire à voix haute est facultatif, donc
  // son absence n'est pas un échec de l'installation.
  return dictationState.ok ? 0 : 1;
}

async function dictate(paths: VoicePaths, args: string[]): Promise<number> {
  const { dictation, speech } = build(paths);
  const available = await dictation.availability();
  if (!available.ok) {
    process.stderr.write(`\n${available.reason ?? ""}\n→ ${available.remedy ?? ""}\n\n`);
    return 1;
  }

  const secondsRaw = args[args.indexOf("--seconds") + 1];
  const seconds = args.includes("--seconds") ? Number(secondsRaw) : 5;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
    process.stderr.write("--seconds attend un nombre entre 1 et 60.\n");
    return 1;
  }

  process.stdout.write(`\nParlez — ${String(seconds)} secondes.\n\n`);
  await dictation.start({
    onPartial: (text) => {
      process.stdout.write(`  … ${text}\n`);
    },
  });
  await systemClock.sleep(seconds * 1_000);
  const result = await dictation.stop();

  if (result.text.length === 0) {
    process.stdout.write("\n  (rien entendu)\n\n");
    return 0;
  }
  process.stdout.write(`\n  « ${result.text} »\n\n`);

  if (args.includes("--speak") && (await speech.isAvailable())) {
    await speech.speak(result.text);
  }
  return 0;
}

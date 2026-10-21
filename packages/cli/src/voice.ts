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
 * `nexus voice` — local voice testing and diagnostics.
 *
 *   nexus voice check     diagnoses missing voice components
 *   nexus voice dictate   runs a test dictation and prints output
 */

export interface VoicePaths {
  model: string;
  voice: string;
  scratch: string;
}

export function voicePaths(home = homedir()): VoicePaths {
  const root = join(home, ".nexus");
  return {
    model: process.env.NEXUS_WHISPER_MODEL ?? join(root, "models", "ggml-base.bin"),
    voice: process.env.NEXUS_PIPER_VOICE ?? join(root, "voices", "en_US-lessac-medium.onnx"),
    scratch: join(root, "audio-scratch"),
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
    language: "en",
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
        `unknown subcommand: ${subcommand}\nusage: nexus voice [check|dictate]\n`,
      );
      return 1;
  }
}

async function checkVoice(paths: VoicePaths): Promise<number> {
  const { dictation, speech } = build(paths);
  process.stdout.write("\nNEXUS — local voice\n\n");

  const dictationState = await dictation.availability();
  const speechState = await speech.availability();

  const line = (label: string, state: { ok: boolean; reason?: string; remedy?: string }) => {
    process.stdout.write(`  ${state.ok ? "✓" : "✗"} ${label.padEnd(22)}`);
    process.stdout.write(
      state.ok ? "ready\n" : `${state.reason ?? ""}\n      → ${state.remedy ?? ""}\n`,
    );
  };

  line("dictation (whisper.cpp)", dictationState);
  line("synthesis (Piper)", speechState);

  process.stdout.write(`\n  model     ${paths.model}\n  voice     ${paths.voice}\n`);
  process.stdout.write(`  audio     ${paths.scratch} (no persistent recordings kept)\n\n`);

  if (!dictationState.ok || !speechState.ok) {
    process.stdout.write(
      "  Both systems are independent: dictation works without speech synthesis.\n\n",
    );
  }
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
    process.stderr.write("--seconds requires a number between 1 and 60.\n");
    return 1;
  }

  process.stdout.write(`\nSpeak now — ${String(seconds)} seconds.\n\n`);
  await dictation.start({
    onPartial: (text) => {
      process.stdout.write(`  … ${text}\n`);
    },
  });
  await systemClock.sleep(seconds * 1_000);
  const result = await dictation.stop();

  if (result.text.length === 0) {
    process.stdout.write("\n  (no speech detected)\n\n");
    return 0;
  }
  process.stdout.write(`\n  "${result.text}"\n\n`);

  if (args.includes("--speak") && (await speech.isAvailable())) {
    await speech.speak(result.text);
  }
  return 0;
}

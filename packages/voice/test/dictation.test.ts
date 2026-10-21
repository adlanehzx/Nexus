import { describe, expect, it } from "vitest";
import { AudioScratch } from "../src/scratch.js";
import { VoiceUnavailableError, WhisperDictation, cleanTranscript } from "../src/whisper.js";
import { FakeClock, FakeFiles, FakeProcess } from "./fakes.js";

const MODEL = "/home/adlane/.nexus/modeles/ggml-base.bin";

function dictation(options: { segmentMs?: number; maxListeningMs?: number } = {}) {
  const process = new FakeProcess();
  const files = new FakeFiles();
  const clock = new FakeClock();

  // Tout est en place par défaut : les tests d'indisponibilité retirent ce
  // qu'ils veulent éprouver.
  process.available.add("whisper-cli").add("arecord");
  files.files.set(MODEL, 142_000_000);
  process.longRunning.add("arecord");
  process.outputs.set("whisper-cli", "Bonjour, range mes mails.");

  const scratch = new AudioScratch({
    files,
    directory: "/tmp/nexus-audio",
    newName: () => "dictee.wav",
  });

  const whisper = new WhisperDictation({
    process,
    files,
    clock,
    scratch,
    modelPath: MODEL,
    language: "fr",
    ...options,
  });
  return { whisper, process, files, clock };
}

describe("disponibilité", () => {
  it("nomme ce qui manque, et le geste qui corrige", async () => {
    const { whisper, process } = dictation();
    process.available.delete("whisper-cli");
    const availability = await whisper.availability();
    // « Dictée indisponible » oblige à chercher ; « installez whisper.cpp »
    // ferme la question.
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("whisper-cli");
    expect(availability.remedy).toContain("whisper.cpp");
  });

  it("distingue le modèle absent du binaire absent", async () => {
    const { whisper, files } = dictation();
    files.files.delete(MODEL);
    const availability = await whisper.availability();
    expect(availability.reason).toContain("modèle");
    expect(availability.remedy).toContain(MODEL);
  });

  it("distingue l'enregistreur absent", async () => {
    const { whisper, process } = dictation();
    process.available.delete("arecord");
    expect((await whisper.availability()).reason).toContain("arecord");
  });

  it("refuse de démarrer plutôt que d'échouer au milieu", async () => {
    const { whisper, process } = dictation();
    process.available.delete("whisper-cli");
    await expect(whisper.start()).rejects.toBeInstanceOf(VoiceUnavailableError);
    expect(whisper.listening).toBe(false);
  });
});

describe("écoute", () => {
  it("ouvre le micro en 16 kHz mono, le format que whisper attend", async () => {
    const { whisper, process, files } = dictation({ maxListeningMs: 1 });
    files.files.set("/tmp/nexus-audio/dictee.wav", 64_000);
    await whisper.start();

    const recording = process.of("arecord")[0];
    expect(recording?.args).toContain("16000");
    expect(recording?.args).toContain("S16_LE");
    expect(recording?.args).toContain("/tmp/nexus-audio/dictee.wav");
  });

  it("rend des transcriptions partielles au fil des segments", async () => {
    const { whisper, files } = dictation({ segmentMs: 2_000, maxListeningMs: 6_000 });
    files.files.set("/tmp/nexus-audio/dictee.wav", 64_000);

    const partials: string[] = [];
    await whisper.start({ onPartial: (text) => partials.push(text) });
    // La latence perçue est celle d'un segment : c'est ce que « streaming »
    // veut dire ici, et ce que ce test fixe.
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(partials[0]).toBe("Bonjour, range mes mails.");
  });

  it("ne lance pas whisper sur un WAV qui n'a que son en-tête", async () => {
    const { whisper, process, files } = dictation({ segmentMs: 1, maxListeningMs: 3 });
    files.files.set("/tmp/nexus-audio/dictee.wav", 44);
    await whisper.start();
    // Il n'y a rien à transcrire : lancer un processus pour rendre du vide
    // coûte une seconde de machine à chaque segment de silence.
    expect(process.of("whisper-cli")).toHaveLength(0);
  });

  it("ferme le micro au plafond de durée, et garde ce qui a été dit", async () => {
    const { whisper, process, files } = dictation({ segmentMs: 1_000, maxListeningMs: 2_000 });
    files.files.set("/tmp/nexus-audio/dictee.wav", 64_000);
    await whisper.start();

    // Le plafond est un garde-fou contre une interface distraite — mais jeter
    // la dictée pour la punir serait absurde.
    expect(process.of("arecord")[0]?.killed).toBe(true);
    expect(whisper.listening).toBe(false);
    const result = await whisper.stop();
    expect(result.text).toContain("Bonjour");
  });

  it("transmet la langue et le modèle à whisper, et n'écrit aucun fichier de sortie", async () => {
    const { whisper, process, files } = dictation({ segmentMs: 1, maxListeningMs: 3 });
    files.files.set("/tmp/nexus-audio/dictee.wav", 64_000);
    await whisper.start();

    const run = process.of("whisper-cli")[0];
    expect(run?.args).toEqual(
      expect.arrayContaining(["-m", MODEL, "-f", "/tmp/nexus-audio/dictee.wav", "-l", "fr"]),
    );
    // Le texte vient sur la sortie standard : la transcription ne crée donc
    // aucun fichier qu'il faudrait supprimer ensuite.
    expect(run?.args.some((arg) => arg.startsWith("--output"))).toBe(false);
  });

  it("supprime l'enregistrement quand l'écoute se termine", async () => {
    const { whisper, files } = dictation({ segmentMs: 1, maxListeningMs: 2 });
    files.files.set("/tmp/nexus-audio/dictee.wav", 64_000);
    await whisper.start();
    expect(files.files.has("/tmp/nexus-audio/dictee.wav")).toBe(false);
    expect(files.removals).toContain("/tmp/nexus-audio/dictee.wav");
  });
});

describe("annulation", () => {
  it("jette la transcription sans l'envoyer", async () => {
    const { whisper, files } = dictation({ segmentMs: 1_000, maxListeningMs: 5_000 });
    files.files.set("/tmp/nexus-audio/dictee.wav", 64_000);
    await whisper.start();

    await whisper.cancel();
    const result = await whisper.stop();
    // Une transcription déjà calculée ne doit pas partir parce qu'elle était
    // prête : annuler annule.
    expect(result.text).toBe("");
    expect(result.segments).toEqual([]);
  });

  it("ferme le micro", async () => {
    const { whisper, process, files } = dictation({ segmentMs: 1_000, maxListeningMs: 5_000 });
    files.files.set("/tmp/nexus-audio/dictee.wav", 64_000);
    await whisper.start();
    await whisper.cancel();
    expect(process.of("arecord")[0]?.killed).toBe(true);
    expect(whisper.listening).toBe(false);
  });
});

describe("nettoyage de la sortie de whisper", () => {
  it("retire les lignes de diagnostic et les marqueurs", () => {
    const raw = [
      "whisper_init_from_file_with_params_no_state: loading model",
      "[00:00:00.000 --> 00:00:02.000]",
      " Bonjour, range mes mails.",
      "(silence)",
      "",
    ].join("\n");
    // Les retirer ici, et non dans l'interface, évite que chaque surface
    // réinvente le filtre — et en oublie un.
    expect(cleanTranscript(raw)).toBe("Bonjour, range mes mails.");
  });

  it("rend une chaîne vide quand il n'y a que du bruit", () => {
    expect(cleanTranscript("(silence)\n(musique)\n")).toBe("");
    expect(cleanTranscript("")).toBe("");
  });

  it("recolle plusieurs lignes utiles", () => {
    expect(cleanTranscript("Bonjour.\nComment vas-tu ?")).toBe("Bonjour. Comment vas-tu ?");
  });
});

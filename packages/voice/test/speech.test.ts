import { describe, expect, it } from "vitest";
import { PiperSpeech } from "../src/piper.js";
import { VoiceUnavailableError } from "../src/whisper.js";
import { FakeProcess } from "./fakes.js";

const VOICE = "/home/adlane/.nexus/voix/fr_FR-siwis-medium.onnx";

/** Attend que la synthèse ait réellement démarré, au lieu de l'espérer. */
async function untilSpeaking(piper: PiperSpeech): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (piper.speaking) return;
    await Promise.resolve();
  }
  throw new Error("la synthèse n'a jamais démarré");
}

function speech() {
  const process = new FakeProcess();
  process.available.add("piper").add("aplay");
  const piper = new PiperSpeech({ process, modelPath: VOICE, lengthScale: 1 });
  return { piper, process };
}

describe("disponibilité", () => {
  it("nomme le binaire manquant et le geste", async () => {
    const { piper, process } = speech();
    process.available.delete("piper");
    const availability = await piper.availability();
    expect(availability.ok).toBe(false);
    expect(availability.remedy).toContain("Piper");
  });

  it("distingue le lecteur audio manquant", async () => {
    const { piper, process } = speech();
    process.available.delete("aplay");
    expect((await piper.availability()).reason).toContain("aplay");
  });

  it("refuse de parler plutôt que d'échouer à moitié", async () => {
    const { piper, process } = speech();
    process.available.delete("piper");
    await expect(piper.speak("Bonjour")).rejects.toBeInstanceOf(VoiceUnavailableError);
  });
});

describe("prononcer", () => {
  it("passe le texte sur l'entrée standard, et ne crée aucun fichier", async () => {
    const { piper, process } = speech();
    await piper.speak("Trois mails importants.");

    const synthesis = process.of("piper")[0];
    expect(synthesis?.stdin).toBe("Trois mails importants.");
    // `--output_raw` : le flux va au lecteur par un tube. Aucun fichier, donc
    // aucun fichier à supprimer — contrairement à la dictée.
    expect(synthesis?.args).toContain("--output_raw");
    expect(synthesis?.args.some((arg) => arg.endsWith(".wav"))).toBe(false);
  });

  it("lance le lecteur au format que Piper produit", async () => {
    const { piper, process } = speech();
    await piper.speak("Bonjour");
    const player = process.of("aplay")[0];
    expect(player?.args).toEqual(expect.arrayContaining(["-r", "22050", "-f", "S16_LE"]));
  });

  it("remplace une phrase en cours au lieu de parler par-dessus", async () => {
    const { piper, process } = speech();
    process.longRunning.add("piper").add("aplay");

    const first = piper.speak("Première phrase");
    await untilSpeaking(piper);
    const second = piper.speak("Deuxième phrase");
    await first;

    // Parler par-dessus soi-même est toujours une erreur : la première phrase
    // est coupée, la seconde la remplace.
    expect(process.of("piper")[0]?.killed).toBe(true);
    expect(process.of("piper")).toHaveLength(2);
    expect(process.of("piper")[1]?.killed).toBe(false);

    // On termine la seconde, sinon le test attendrait un processus qui, par
    // construction, ne finit jamais seul.
    await piper.stop();
    await second;
  });
});

describe("interruption", () => {
  it("tue la synthèse **et** le lecteur", async () => {
    const { piper, process } = speech();
    process.longRunning.add("piper").add("aplay");

    const speaking = piper.speak("Une longue phrase");
    await untilSpeaking(piper);
    await piper.stop();
    await speaking;

    // Ne tuer que la synthèse laisserait le lecteur vider son tampon, c'est-à-
    // dire continuer à parler une seconde après qu'on lui a dit de se taire —
    // ce que l'utilisateur perçoit comme « ça ne m'écoute pas ».
    expect(process.of("piper")[0]?.killed).toBe(true);
    expect(process.of("aplay")[0]?.killed).toBe(true);
  });

  it("marque la phrase comme coupée, sans lever", async () => {
    const { piper, process } = speech();
    process.longRunning.add("piper").add("aplay");

    const speaking = piper.speak("Une longue phrase");
    await untilSpeaking(piper);
    await piper.stop();
    const outcome = await speaking;

    // Une interruption est le comportement voulu, pas une panne — mais
    // l'appelant doit pouvoir ne pas enchaîner comme si la phrase avait été
    // entendue.
    expect(outcome.interrupted).toBe(true);
    expect(piper.interrupted).toBe(true);
  });

  it("ne marque rien quand la phrase est allée au bout", async () => {
    const { piper } = speech();
    const outcome = await piper.speak("Phrase courte");
    expect(outcome.interrupted).toBe(false);
  });

  it("s'arrêter sans parler ne fait rien", async () => {
    const { piper, process } = speech();
    await piper.stop();
    expect(process.runs).toHaveLength(0);
    expect(piper.interrupted).toBe(false);
  });
});

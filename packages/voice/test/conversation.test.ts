import { describe, expect, it } from "vitest";
import { HandsFreeConversation } from "../src/conversation.js";
import { PiperSpeech } from "../src/piper.js";
import { AudioScratch } from "../src/scratch.js";
import { WhisperDictation } from "../src/whisper.js";
import { FakeClock, FakeFiles, FakeProcess } from "./fakes.js";

/**
 * Conversation mains libres.
 *
 * Ce qui est éprouvé n'est pas qu'elle « marche » : c'est qu'elle **s'arrête**.
 * Un assistant qui resterait à l'écoute « au cas où » est exactement ce que
 * NEXUS refuse d'être, et les trois sorties — silence, plafond de tours,
 * plafond de durée — sont donc chacune attaquées.
 */

const MODEL = "/modeles/base.bin";
const VOICE = "/voix/fr.onnx";

function conversation(
  options: {
    heard?: string[];
    maxTurns?: number;
    maxDurationMs?: number;
    onSpeechDetected?: (listener: () => void) => () => void;
  } = {},
) {
  const process = new FakeProcess();
  const files = new FakeFiles();
  const clock = new FakeClock();
  process.available.add("whisper-cli").add("arecord").add("piper").add("aplay");
  files.files.set(MODEL, 1_000);
  process.longRunning.add("arecord");

  // Ce que la personne dit, tour par tour. Une chaîne vide = un silence, donc
  // la fin de la conversation.
  const heard = [...(options.heard ?? ["Range mes mails.", ""])];
  let turn = 0;
  process.outputs.set("whisper-cli", heard[0] ?? "");

  const dictation = new WhisperDictation({
    process,
    files,
    clock,
    scratch: new AudioScratch({ files, directory: "/tmp/a", newName: () => "d.wav" }),
    modelPath: MODEL,
    segmentMs: 1_000,
    maxListeningMs: 2_000,
  });
  const speech = new PiperSpeech({ process, modelPath: VOICE });

  const answers: string[] = [];
  const loop = new HandsFreeConversation({
    dictation,
    speech,
    clock,
    turnMs: 2_000,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
    ...(options.onSpeechDetected === undefined
      ? {}
      : { onSpeechDetected: options.onSpeechDetected }),
    answer: (text) => {
      answers.push(text);
      turn += 1;
      // Le tour suivant entendra la phrase suivante.
      process.outputs.set("whisper-cli", heard[turn] ?? "");
      return Promise.resolve(`J'ai traité : ${text}`);
    },
  });

  // L'enregistreur écrit un WAV à chaque tour. Le modéliser est nécessaire :
  // l'enregistrement est supprimé à la fin de chaque tour, donc sans cela le
  // second tour n'entendrait qu'un silence.
  process.effects.set("arecord", (args) => {
    const path = args.at(-1);
    if (path !== undefined) files.files.set(path, 64_000);
  });

  return { loop, process, files, clock, answers };
}

describe("un tour", () => {
  it("écoute, répond, prononce", async () => {
    const { loop, process, answers } = conversation();
    const outcome = await loop.run();

    expect(answers).toEqual(["Range mes mails."]);
    expect(outcome.turns).toHaveLength(1);
    expect(outcome.turns[0]?.answered).toContain("J'ai traité");
    expect(process.of("piper")[0]?.stdin).toContain("J'ai traité");
  });

  it("s'arrête sur un silence, sans formule magique", async () => {
    // C'est la sortie naturelle : on s'arrête de parler, et ça s'arrête.
    const { loop } = conversation({ heard: [""] });
    const outcome = await loop.run();
    expect(outcome.stoppedBy).toBe("silence");
    expect(outcome.turns).toHaveLength(0);
  });
});

describe("les conversations s'arrêtent", () => {
  it("au plafond de tours", async () => {
    const { loop } = conversation({
      heard: ["un", "deux", "trois", "quatre"],
      maxTurns: 2,
    });
    const outcome = await loop.run();
    // Une conversation sans fin finit par être une écoute permanente.
    expect(outcome.stoppedBy).toBe("plafond-de-tours");
    expect(outcome.turns).toHaveLength(2);
  });

  it("au plafond de durée", async () => {
    const { loop } = conversation({
      heard: ["un", "deux", "trois", "quatre", "cinq"],
      maxDurationMs: 5_000,
    });
    const outcome = await loop.run();
    expect(outcome.stoppedBy).toBe("plafond-de-durée");
  });

  it("quand on le demande", async () => {
    const { loop } = conversation({ heard: ["un", "deux", "trois"] });
    const run = loop.run();
    loop.stop();
    const outcome = await run;
    expect(outcome.stoppedBy).toBe("demandée");
  });

  it("ferme le micro et la parole en sortant, quoi qu'il arrive", async () => {
    const { loop, process } = conversation({ heard: [""] });
    await loop.run();
    // Une sortie par exception ne doit pas laisser un micro ouvert — ici la
    // sortie est normale, mais le `finally` est le même.
    expect(process.of("arecord").every((run) => run.killed)).toBe(true);
    expect(loop.running).toBe(false);
  });

  it("ferme tout même si la réponse lève", async () => {
    const process = new FakeProcess();
    const files = new FakeFiles();
    const clock = new FakeClock();
    process.available.add("whisper-cli").add("arecord").add("piper").add("aplay");
    files.files.set(MODEL, 1_000);
    process.longRunning.add("arecord");
    process.outputs.set("whisper-cli", "Fais quelque chose.");
    files.files.set("/tmp/a/d.wav", 64_000);

    const loop = new HandsFreeConversation({
      dictation: new WhisperDictation({
        process,
        files,
        clock,
        scratch: new AudioScratch({ files, directory: "/tmp/a", newName: () => "d.wav" }),
        modelPath: MODEL,
        segmentMs: 1_000,
        maxListeningMs: 2_000,
      }),
      speech: new PiperSpeech({ process, modelPath: VOICE }),
      clock,
      turnMs: 2_000,
      answer: () => Promise.reject(new Error("l'agent a échoué")),
    });

    await expect(loop.run()).rejects.toThrow("l'agent a échoué");
    expect(process.of("arecord").every((run) => run.killed)).toBe(true);
    expect(loop.running).toBe(false);
  });
});

describe("interruption vocale", () => {
  it("coupe la parole dès que la personne parle", async () => {
    let fire: (() => void) | undefined;
    const { loop, process } = conversation({
      heard: ["Dis-moi tout", ""],
      onSpeechDetected: (listener) => {
        fire = listener;
        return () => {
          fire = undefined;
        };
      },
    });
    process.longRunning.add("piper").add("aplay");

    const run = loop.run();
    // On attend que la synthèse ait démarré, puis on parle par-dessus.
    for (let index = 0; index < 200 && fire === undefined; index += 1) {
      await Promise.resolve();
    }
    for (let index = 0; index < 200 && process.of("piper").length === 0; index += 1) {
      await Promise.resolve();
    }
    fire?.();
    const outcome = await run;

    // C'est la différence entre une conversation et un répondeur : on peut
    // couper la parole.
    expect(process.of("piper")[0]?.killed).toBe(true);
    expect(outcome.turns[0]?.interrupted).toBe(true);
  });

  it("désarme la détection après le tour", async () => {
    let armed = 0;
    let disarmed = 0;
    const { loop } = conversation({
      heard: ["un", ""],
      onSpeechDetected: () => {
        armed += 1;
        return () => {
          disarmed += 1;
        };
      },
    });
    await loop.run();

    // Une détection qui survivrait au tour couperait le tour suivant.
    expect(armed).toBe(1);
    expect(disarmed).toBe(1);
  });

  it("sans détecteur, la parole va jusqu'au bout", async () => {
    // Mieux vaut pas d'interruption qu'une interruption qui se déclenche sur le
    // bruit du ventilateur et coupe chaque phrase.
    const { loop } = conversation({ heard: ["un", ""] });
    const outcome = await loop.run();
    expect(outcome.turns[0]?.interrupted).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { InMemoryMemoryProvider } from "../src/in-memory.js";
import { ContextAssembler } from "../src/context.js";
import { ShortTermContext } from "../src/short-term.js";
import type {
  ConversationHistoryPort,
  DeviceContextPort,
  TaskHistoryPort,
} from "../src/sources.js";

/**
 * L'assemblage du contexte.
 *
 * Six couches s'y rejoignent, et le point de ce fichier est de vérifier
 * qu'elles s'y rejoignent **sans se mélanger** : chacune garde sa section et son
 * budget, et aucune ne peut affamer les autres.
 *
 * Les quatre sources extérieures sont des doubles — c'est tout l'intérêt de les
 * avoir déclarées comme ports : l'assemblage se teste sans base, sans registre
 * d'appareils et sans coordinateur de tâches.
 */

const ADLAN = "user-example";
const CONVERSATION = "conv-1";
const NOW = new Date("2026-09-03T10:00:00.000Z");

class FakeConversation implements ConversationHistoryPort {
  turns: { role: string; content: string; createdAt: Date }[] = [];

  recentTurns(): Promise<{ role: string; content: string; createdAt: Date }[]> {
    return Promise.resolve(this.turns);
  }
}

class FakeDevices implements DeviceContextPort {
  devices = [
    {
      id: "d1",
      name: "Portable Windows",
      role: "BOTH",
      status: "ONLINE",
      capabilities: ["terminal.execute"],
    },
  ];

  devicesFor(): Promise<typeof this.devices> {
    return Promise.resolve(this.devices);
  }
}

class FakeTasks implements TaskHistoryPort {
  tasks = [
    {
      id: "t1",
      title: "Lancer les tests",
      status: "succeeded",
      completedAt: NOW,
      deviceName: "Portable Windows",
    },
  ];

  recentTasks(): Promise<typeof this.tasks> {
    return Promise.resolve(this.tasks);
  }
}

function makeAssembler(budget?: Parameters<typeof makeRaw>[0]) {
  return makeRaw(budget);
}

function makeRaw(budget?: Partial<ConstructorParameters<typeof ContextAssembler>[0]["budget"]>) {
  const memory = new InMemoryMemoryProvider({ now: () => NOW });
  const shortTerm = new ShortTermContext({ now: () => NOW });
  const conversation = new FakeConversation();
  const devices = new FakeDevices();
  const tasks = new FakeTasks();

  const assembler = new ContextAssembler({
    memory,
    shortTerm,
    conversation,
    devices,
    tasks,
    ...(budget === undefined ? {} : { budget }),
  });

  return { assembler, memory, shortTerm, conversation, devices, tasks };
}

function section(assembled: Awaited<ReturnType<ContextAssembler["assemble"]>>, name: string) {
  return assembled.sections.find((candidate) => candidate.name === name);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("séparation des couches", () => {
  it("chaque source a sa section", async () => {
    const { assembler, memory, shortTerm } = makeAssembler();

    await memory.store({
      userId: ADLAN,
      kind: "PROCEDURAL",
      content: "Réponds en français",
      layer: "PREFERENCE",
    });
    await memory.store({ userId: ADLAN, kind: "SEMANTIC", content: "Habite à Lyon" });
    shortTerm.set(CONVERSATION, "fichier-courant", "src/auth.ts");

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "où habite Alex",
    });

    expect(assembled.sections.map((s) => s.name)).toEqual([
      "preferences",
      "shortTerm",
      "longTerm",
      "devices",
      "tasks",
      "conversation",
    ]);
  });

  it("une préférence ne se retrouve pas parmi les souvenirs", async () => {
    // Confondre les deux ferait disparaître une consigne permanente dès que la
    // conversation change de sujet.
    const { assembler, memory } = makeAssembler();

    await memory.store({
      userId: ADLAN,
      kind: "PROCEDURAL",
      content: "Réponds toujours en français",
      layer: "PREFERENCE",
    });

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "docker",
    });

    expect(section(assembled, "preferences")?.lines).toHaveLength(1);
    expect(section(assembled, "longTerm")?.lines).toEqual([]);
  });

  it("les préférences remontent quel que soit le sujet", async () => {
    // Recherchées à requête vide, précisément parce qu'une consigne permanente
    // n'a aucune raison de ressembler au message du jour.
    const { assembler, memory } = makeAssembler();

    await memory.store({
      userId: ADLAN,
      kind: "PROCEDURAL",
      content: "Réponds toujours en français",
      layer: "PREFERENCE",
    });

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "quelle est la météo à Tokyo",
    });

    expect(section(assembled, "preferences")?.lines[0]).toContain("français");
  });

  it("les souvenirs, eux, dépendent du sujet", async () => {
    const { assembler, memory } = makeAssembler();

    await memory.store({ userId: ADLAN, kind: "SEMANTIC", content: "Habite à Lyon" });
    await memory.store({ userId: ADLAN, kind: "SEMANTIC", content: "Aime le café serré" });

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "où habite-t-il",
    });

    expect(section(assembled, "longTerm")?.lines).toEqual(["- Habite à Lyon"]);
  });

  it("signale ce qui a été déduit plutôt qu'affirmé", async () => {
    // « L'utilisateur a dit » et « déduit d'une conversation » n'ont pas la même
    // autorité. Le modèle doit pouvoir nuancer.
    const { assembler, memory } = makeAssembler();

    await memory.store({
      userId: ADLAN,
      kind: "SEMANTIC",
      content: "Travaille sur NEXUS",
      origin: "AGENT",
    });

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "travaille",
    });

    expect(section(assembled, "longTerm")?.lines[0]).toContain("(déduit)");
  });
});

describe("budgets", () => {
  it("une conversation bavarde n'affame pas les préférences", async () => {
    // Le défaut classique d'un budget global : l'historique mange tout, et les
    // trois lignes qui changent la réponse tombent parce qu'elles arrivent en
    // dernier.
    const { assembler, memory, conversation } = makeAssembler();

    await memory.store({
      userId: ADLAN,
      kind: "PROCEDURAL",
      content: "Réponds toujours en français",
      layer: "PREFERENCE",
    });
    conversation.turns = Array.from({ length: 200 }, (_, index) => ({
      role: "user",
      content: `Message très bavard numéro ${String(index)} `.repeat(10),
      createdAt: NOW,
    }));

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "docker",
    });

    expect(section(assembled, "preferences")?.lines[0]).toContain("français");
  });

  it("chaque section respecte son propre plafond", async () => {
    const { assembler, memory } = makeAssembler({ longTerm: 60 });

    for (let index = 0; index < 20; index += 1) {
      await memory.store({
        userId: ADLAN,
        kind: "SEMANTIC",
        content: `Souvenir numéro ${String(index)} à propos du train`,
      });
    }

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "train",
    });

    const longTerm = section(assembled, "longTerm");
    expect(longTerm?.chars).toBeLessThanOrEqual(60);
    expect(longTerm?.dropped).toBeGreaterThan(0);
  });

  it("coupe entre les lignes, jamais au milieu", async () => {
    // Une préférence tronquée à mi-phrase peut changer de sens, et le modèle
    // n'a aucun moyen de savoir qu'il lui manque la fin.
    const { assembler, memory } = makeAssembler({ preferences: 40 });

    await memory.store({
      userId: ADLAN,
      kind: "PROCEDURAL",
      content: "Ne jamais supprimer un fichier sans demander",
      layer: "PREFERENCE",
    });

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "x",
    });

    const lines = section(assembled, "preferences")?.lines ?? [];
    for (const line of lines) expect(line).toContain("sans demander");
  });

  it("garde les tours les plus récents de la conversation", async () => {
    // Ce sont eux que la question courante prolonge.
    const { assembler, conversation } = makeAssembler({ conversation: 60 });

    conversation.turns = [
      { role: "user", content: "tout premier message", createdAt: NOW },
      { role: "user", content: "message du milieu", createdAt: NOW },
      { role: "user", content: "tout dernier message", createdAt: NOW },
    ];

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "x",
    });

    const lines = section(assembled, "conversation")?.lines ?? [];
    expect(lines.join("\n")).toContain("tout dernier message");
    expect(lines.join("\n")).not.toContain("tout premier message");
  });

  it("rend les tours dans l'ordre chronologique", async () => {
    // Ils sont sélectionnés du plus récent au plus ancien, mais un transcript
    // à l'envers est illisible pour un modèle comme pour un humain.
    const { assembler, conversation } = makeAssembler();

    conversation.turns = [
      { role: "user", content: "premier", createdAt: NOW },
      { role: "assistant", content: "second", createdAt: NOW },
    ];

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "x",
    });

    expect(section(assembled, "conversation")?.lines).toEqual([
      "- user : premier",
      "- assistant : second",
    ]);
  });
});

describe("frontière entre utilisateurs", () => {
  it("n'assemble jamais le contexte de quelqu'un d'autre", async () => {
    const { assembler, memory } = makeAssembler();

    await memory.store({ userId: "user-autre", kind: "SEMANTIC", content: "Secret d'un autre" });

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "secret",
    });

    expect(assembled.text).not.toContain("Secret d'un autre");
  });
});

describe("sources absentes", () => {
  it("s'assemble sans appareils, sans tâches et sans historique", async () => {
    // Le cœur agent peut tourner avec la seule mémoire branchée. Une source
    // absente donne une section vide, pas une exception.
    const memory = new InMemoryMemoryProvider({ now: () => NOW });
    await memory.store({ userId: ADLAN, kind: "SEMANTIC", content: "Habite à Lyon" });

    const assembled = await new ContextAssembler({ memory }).assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "habite",
    });

    expect(assembled.text).toContain("Habite à Lyon");
    expect(section(assembled, "devices")?.lines).toEqual([]);
  });

  it("ne produit aucun titre pour une section vide", async () => {
    const memory = new InMemoryMemoryProvider({ now: () => NOW });

    const assembled = await new ContextAssembler({ memory }).assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "rien",
    });

    expect(assembled.text).toBe("");
    expect(assembled.chars).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("contexte court terme", () => {
  it("remplace une note de même clé au lieu d'en empiler deux", async () => {
    // Deux notes contradictoires sur le fichier courant, et le modèle n'a aucun
    // moyen de savoir laquelle est à jour.
    const { assembler, shortTerm } = makeAssembler();

    shortTerm.set(CONVERSATION, "fichier-courant", "src/auth.ts");
    shortTerm.set(CONVERSATION, "fichier-courant", "src/memory.ts");

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "x",
    });

    expect(section(assembled, "shortTerm")?.lines).toEqual(["- fichier-courant : src/memory.ts"]);
  });

  it("ne fuit pas d'une conversation à l'autre", async () => {
    const { assembler, shortTerm } = makeAssembler();

    shortTerm.set("autre-conversation", "fichier-courant", "src/secret.ts");

    const assembled = await assembler.assemble({
      userId: ADLAN,
      conversationId: CONVERSATION,
      query: "x",
    });

    expect(section(assembled, "shortTerm")?.lines).toEqual([]);
  });

  it("s'efface avec le temps", () => {
    // Ce qui vit le temps d'une session n'a aucune raison de lui survivre.
    let clock = NOW;
    const shortTerm = new ShortTermContext({ ttlMs: 1_000, now: () => clock });

    shortTerm.set(CONVERSATION, "fichier-courant", "src/auth.ts");
    expect(shortTerm.list(CONVERSATION)).toHaveLength(1);

    clock = new Date(NOW.getTime() + 2_000);
    expect(shortTerm.list(CONVERSATION)).toEqual([]);
  });

  it("reste borné", () => {
    const shortTerm = new ShortTermContext({ maxNotesPerConversation: 3, now: () => NOW });

    for (let index = 0; index < 10; index += 1) {
      shortTerm.set(CONVERSATION, `cle-${String(index)}`, "valeur");
    }

    const notes = shortTerm.list(CONVERSATION);
    expect(notes).toHaveLength(3);
    expect(notes.map((note) => note.key)).toEqual(["cle-7", "cle-8", "cle-9"]);
  });

  it("rafraîchir une note la remet en fin de file", () => {
    // Sans quoi la note la plus utilisée tomberait parce qu'elle avait été
    // posée en premier.
    const shortTerm = new ShortTermContext({ maxNotesPerConversation: 2, now: () => NOW });

    shortTerm.set(CONVERSATION, "a", "1");
    shortTerm.set(CONVERSATION, "b", "1");
    shortTerm.set(CONVERSATION, "a", "2");
    shortTerm.set(CONVERSATION, "c", "1");

    expect(shortTerm.list(CONVERSATION).map((note) => note.key)).toEqual(["a", "c"]);
  });
});

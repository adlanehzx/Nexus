import { describe, expect, it } from "vitest";
import type { MessageView } from "@nexus/client-core";
import { InvalidTaskDraftError, taskRequestBody } from "../src/lib/tasks.js";
import { mergeHistory } from "../src/lib/history.js";

/**
 * Ce que la fenêtre envoie au cœur, et ce qu'elle affiche.
 *
 * Le premier bloc éprouve la propriété centrale de ce lot côté client : une
 * demande partie du portable ne désigne **aucune machine**. C'est ce qui rend
 * impossible, depuis l'interface, le contournement de la sélection et de
 * l'autorisation du cœur.
 */

describe("composition d'une tâche", () => {
  const brouillon = {
    title: "Lancer les tests du dépôt",
    steps: [
      {
        description: "Exécuter pnpm test",
        requiredCapabilities: ["terminal.execute"],
        tool: "terminal.execute",
        arguments: { command: "pnpm", args: ["test"] },
      },
    ],
  };

  it("déclare des capacités, jamais un exécutant", () => {
    const corps = taskRequestBody(brouillon, "device-portable");
    const serialise = JSON.stringify(corps);

    // Aucun champ de ciblage, sous aucun nom. Le jour où quelqu'un en ajoute
    // un, ce test tombe — et c'est exactement le moment où il faut en parler.
    for (const champ of [
      "targetDeviceId",
      "deviceId",
      "workerDeviceId",
      "executeOn",
      "runOn",
      "selectedDeviceId",
    ]) {
      expect(serialise).not.toContain(champ);
    }

    expect(corps.steps[0]?.requiredCapabilities).toEqual(["terminal.execute"]);
  });

  it("transmet l'appareil d'origine, qui désigne la source et non la cible", () => {
    const corps = taskRequestBody(brouillon, "device-portable");

    expect(corps.originClientDeviceId).toBe("device-portable");
  });

  it("refuse une étape sans capacité requise", () => {
    // Sans capacité, le sélecteur n'a aucun critère : la tâche partirait
    // n'importe où, ou nulle part. Mieux vaut refuser côté client, où
    // l'utilisateur peut encore corriger.
    expect(() =>
      taskRequestBody(
        {
          title: "Tâche floue",
          steps: [{ description: "faire le nécessaire", requiredCapabilities: [], tool: "x" }],
        },
        "device-portable",
      ),
    ).toThrow(InvalidTaskDraftError);
  });

  it("refuse un titre vide et une tâche sans étape", () => {
    expect(() => taskRequestBody({ title: "  ", steps: brouillon.steps }, "d")).toThrow(
      InvalidTaskDraftError,
    );
    expect(() => taskRequestBody({ title: "Titre", steps: [] }, "d")).toThrow(
      InvalidTaskDraftError,
    );
  });

  it("normalise les dépendances absentes", () => {
    const corps = taskRequestBody(brouillon, "device-portable");

    expect(corps.steps[0]?.dependsOn).toEqual([]);
  });

  it("n'invente pas de champ optionnel", () => {
    // `exactOptionalPropertyTypes` interdit `undefined` explicite ; le serveur,
    // lui, refuserait un `riskLevel: undefined` à la validation Zod.
    const corps = taskRequestBody(brouillon, "device-portable");

    expect(Object.keys(corps.steps[0] ?? {})).not.toContain("riskLevel");
    expect(Object.keys(corps)).not.toContain("conversationId");
  });
});

describe("fusion de l'historique et du direct", () => {
  const live: MessageView[] = [
    {
      id: "m2",
      role: "assistant",
      content: "Je lance",
      streaming: true,
      createdAt: "2026-09-02T10:00:02.000Z",
      originClientDeviceId: null,
    },
  ];

  const histoire = [
    {
      id: "m1",
      role: "user",
      content: "Lance les tests",
      createdAt: "2026-09-02T10:00:01.000Z",
      originClientDeviceId: "device-iphone",
    },
    {
      id: "m2",
      role: "assistant",
      content: "Je",
      createdAt: "2026-09-02T10:00:02.000Z",
    },
  ];

  it("ne double pas ce que les deux sources décrivent", () => {
    const fil = mergeHistory(live, histoire);

    expect(fil.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("le direct l'emporte sur l'historique", () => {
    // L'historique connaît « Je », le flux en est à « Je lance » et n'a pas
    // fini. Laisser l'historique gagner effacerait le texte sous les yeux de
    // l'utilisateur.
    const fil = mergeHistory(live, histoire);
    const dernier = fil.at(-1);

    expect(dernier?.content).toBe("Je lance");
    expect(dernier?.streaming).toBe(true);
  });

  it("préserve l'appareil d'origine venu de l'historique", () => {
    // C'est ce qui permet au portable d'afficher « posé depuis l'iPhone ».
    const fil = mergeHistory(live, histoire);

    expect(fil[0]?.originClientDeviceId).toBe("device-iphone");
  });

  it("ordonne chronologiquement, y compris à horodatage égal", () => {
    const memeInstant = [
      { id: "b", role: "user", content: "second", createdAt: "2026-09-02T10:00:00.000Z" },
      { id: "a", role: "user", content: "premier", createdAt: "2026-09-02T10:00:00.000Z" },
    ];

    expect(mergeHistory([], memeInstant).map((message) => message.id)).toEqual(["a", "b"]);
  });

  it("rend un fil vide sans rien inventer", () => {
    expect(mergeHistory([], [])).toEqual([]);
  });
});

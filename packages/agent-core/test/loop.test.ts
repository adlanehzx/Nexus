import { describe, expect, it } from "vitest";
import {
  badOutputTool,
  brokenTool,
  calendarListTool,
  callTurn,
  dangerousTool,
  fileWriteTool,
  hangingTool,
  makeEmailTool,
  makeFlakyTool,
  makeHarness,
  weatherTool,
} from "./fixtures.js";
import type { ToolDefinition } from "@nexus/tools";

const asTools = (...tools: unknown[]): ToolDefinition<never, unknown>[] =>
  tools as ToolDefinition<never, unknown>[];

describe("réponse simple", () => {
  it("répond sans appeler le moindre outil", async () => {
    const h = makeHarness({ turns: [{ kind: "final", text: "Bonjour Adlan." }] });

    const { record } = await h.run("Salut");

    expect(record.status).toBe("completed");
    expect(record.stopReason).toBe("final_answer");
    expect(record.response).toBe("Bonjour Adlan.");
    expect(record.iterations).toBe(1);
    expect(record.toolsUsed).toHaveLength(0);
    expect(record.usage.inputTokens).toBeGreaterThan(0);
  });

  it("trace le run de bout en bout", async () => {
    const h = makeHarness({ turns: [{ kind: "final", text: "ok" }] });
    const { record } = await h.run();

    expect(record.runId).toBeTruthy();
    expect(record.userId).toBe("user-1");
    expect(record.conversationId).toBe("conv-1");
    expect(record.startTime).toBeTruthy();
    expect(record.endTime).toBeTruthy();
    expect(record.errors).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toEqual([
      "run.started",
      "iteration.started",
      "llm.completed",
      "agent.message",
      "run.finished",
    ]);
  });
});

describe("appel d'outil", () => {
  it("exécute l'outil et réinjecte son résultat au modèle", async () => {
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { city: "Paris" }),
        { kind: "final", text: "Il fait 21 °C à Paris." },
      ],
    });

    const { record } = await h.run("Quel temps à Paris ?");

    expect(record.status).toBe("completed");
    expect(record.iterations).toBe(2);
    expect(record.toolsUsed).toHaveLength(1);
    expect(record.toolsUsed[0]).toMatchObject({ name: "weather.get", status: "success" });

    // Le second appel au modèle doit contenir l'observation de l'outil : c'est
    // ce qui distingue une vraie boucle d'un simple appel unique.
    const secondRequest = h.llm.requests[1];
    const toolResult = secondRequest?.messages.at(-1);
    expect(toolResult?.role).toBe("tool");
    expect(JSON.stringify(toolResult?.content)).toContain("21");
  });

  it("n'expose au modèle que les outils autorisés", async () => {
    const h = makeHarness({
      turns: [{ kind: "final", text: "ok" }],
      tools: asTools(weatherTool, calendarListTool),
      permissions: [], // calendar.read non accordée
    });

    await h.run();

    const exposed = h.llm.requests[0]?.tools?.map((t) => t.name);
    expect(exposed).toEqual(["weather.get"]);
  });

  it("décrit les outils par un JSON Schema dérivé de Zod", async () => {
    const h = makeHarness({ turns: [{ kind: "final", text: "ok" }] });
    await h.run();

    expect(h.llm.requests[0]?.tools?.[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });
});

describe("appels d'outils multiples", () => {
  it("exécute plusieurs appels d'un même tour, dans l'ordre", async () => {
    const h = makeHarness({
      turns: [
        {
          kind: "tool_calls",
          calls: [
            { id: "c1", name: "weather.get", arguments: { city: "Paris" } },
            { id: "c2", name: "calendar.list", arguments: { day: "2026-09-02" } },
          ],
        },
        { kind: "final", text: "Voilà." },
      ],
      tools: asTools(weatherTool, calendarListTool),
      permissions: ["calendar.read"],
    });

    const { record } = await h.run();

    expect(record.status).toBe("completed");
    expect(record.toolsUsed.map((t) => t.name)).toEqual(["weather.get", "calendar.list"]);
    expect(record.toolsUsed.every((t) => t.status === "success")).toBe(true);
  });

  it("enchaîne des appels sur plusieurs itérations", async () => {
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { city: "Paris" }, "c1"),
        callTurn("calendar.list", { day: "demain" }, "c2"),
        { kind: "final", text: "Terminé." },
      ],
      tools: asTools(weatherTool, calendarListTool),
      permissions: ["calendar.read"],
    });

    const { record } = await h.run();

    expect(record.iterations).toBe(3);
    expect(record.toolsUsed).toHaveLength(2);
  });
});

describe("échec d'outil", () => {
  it("transforme l'échec en observation et laisse l'agent conclure", async () => {
    const h = makeHarness({
      turns: [
        callTurn("broken.tool", {}),
        { kind: "final", text: "Je n'ai pas pu : le disque est plein." },
      ],
      tools: asTools(brokenTool),
    });

    const { record } = await h.run();

    // Un échec d'outil n'est pas une panne du run : l'agent doit pouvoir
    // l'expliquer plutôt que de s'interrompre.
    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]).toMatchObject({ name: "broken.tool", status: "failed" });
    expect(record.errors).toHaveLength(1);
    expect(JSON.stringify(h.llm.requests[1]?.messages.at(-1))).toContain("Échec");
  });

  it("refuse une sortie non conforme au schéma de l'outil", async () => {
    const h = makeHarness({
      turns: [callTurn("bad.output", {}), { kind: "final", text: "Sortie invalide." }],
      tools: asTools(badOutputTool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]?.status).toBe("failed");
    expect(record.errors[0]?.code).toBe("TOOL_OUTPUT_INVALID");
  });

  it("s'arrête après trop d'échecs consécutifs", async () => {
    const h = makeHarness({
      turns: [
        callTurn("broken.tool", {}, "c1"),
        callTurn("broken.tool", {}, "c2"),
        callTurn("broken.tool", {}, "c3"),
        callTurn("broken.tool", {}, "c4"),
        { kind: "final", text: "jamais atteint" },
      ],
      tools: asTools(brokenTool),
      policy: { maxConsecutiveToolFailures: 2, maxIdenticalToolCalls: 99 },
    });

    const { record } = await h.run();

    expect(record.status).toBe("incomplete");
    expect(record.stopReason).toBe("tool_failure_limit");
    expect(record.response).toContain("En échec");
  });
});

describe("reprise sur erreur", () => {
  it("réessaie un échec transitoire avec un backoff exponentiel", async () => {
    const flaky = makeFlakyTool(2);
    const h = makeHarness({
      turns: [callTurn("flaky.fetch", { url: "https://x" }), { kind: "final", text: "200." }],
      tools: asTools(flaky.tool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]).toMatchObject({ status: "success", attempts: 3 });
    expect(flaky.attempts()).toBe(3);
    // 100 puis 200 : la croissance exponentielle, sans jitter dans les tests.
    expect(h.sleeps).toEqual([100, 200]);
  });

  it("ne réessaie jamais un échec définitif", async () => {
    const h = makeHarness({
      turns: [callTurn("broken.tool", {}), { kind: "final", text: "ok" }],
      tools: asTools(brokenTool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]?.attempts).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("abandonne après avoir épuisé ses tentatives", async () => {
    const flaky = makeFlakyTool(99);
    const h = makeHarness({
      turns: [callTurn("flaky.fetch", { url: "https://x" }), { kind: "final", text: "ko" }],
      tools: asTools(flaky.tool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(flaky.attempts()).toBe(3);
  });
});

describe("délais", () => {
  it("interrompt un outil qui ignore son signal d'annulation", async () => {
    const h = makeHarness({
      turns: [callTurn("slow.task", {}), { kind: "final", text: "trop lent" }],
      tools: asTools(hangingTool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]?.status).toBe("failed");
    expect(record.errors[0]?.code).toBe("TOOL_TIMEOUT");
  });

  it("arrête le run quand le délai global est dépassé", async () => {
    let clock = 1_000_000;
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { city: "Paris" }, "c1"),
        callTurn("weather.get", { city: "Lyon" }, "c2"),
        { kind: "final", text: "jamais atteint" },
      ],
      policy: { globalTimeoutMs: 5_000 },
      now: () => {
        clock += 3_000; // chaque consultation d'horloge avance de 3 s
        return clock;
      },
    });

    const { record } = await h.run();

    expect(record.status).toBe("incomplete");
    expect(record.stopReason).toBe("global_timeout");
    expect(record.response).toContain("délai imparti");
  });
});

describe("annulation", () => {
  it("annule un run pendant que le modèle réfléchit", async () => {
    const h = makeHarness({ turns: [{ kind: "hang" }] });

    const running = h.orchestrator.run({
      userId: "user-1",
      conversationId: "conv-1",
      message: "Tâche longue",
    });

    // L'identifiant est publié par `run.started`, avant que `run()` ne rende la
    // main : c'est ainsi qu'un appelant annule sa propre tâche en vol.
    await new Promise((resolve) => setImmediate(resolve));
    const started = h.events.find((e) => e.type === "run.started");
    expect(started).toBeDefined();
    const runId = started?.type === "run.started" ? started.runId : "";
    expect(await h.store.load(runId)).toBeDefined();

    await h.orchestrator.cancel(runId);

    const { record } = await running;

    expect(record.status).toBe("cancelled");
    expect(record.stopReason).toBe("cancelled");
    expect(record.toolsUsed).toHaveLength(0);
  });

  it("annule un run suspendu en attente de confirmation", async () => {
    const email = makeEmailTool();
    const h = makeHarness({
      turns: [callTurn("email.send", { to: "a@b.c", subject: "s", body: "b" })],
      tools: asTools(email.tool),
      permissions: ["email.send"],
    });

    const { record } = await h.run();
    expect(record.status).toBe("waiting_for_confirmation");

    const cancelled = await h.orchestrator.cancel(record.runId);
    expect(cancelled).toBe(true);

    const after = await h.orchestrator.getRun(record.runId);
    expect(after?.status).toBe("cancelled");
    expect(email.sent).toHaveLength(0);
  });
});

describe("permissions", () => {
  it("refuse un outil dont la permission n'est pas accordée", async () => {
    const h = makeHarness({
      turns: [
        callTurn("calendar.list", { day: "demain" }),
        { kind: "final", text: "Je n'ai pas accès à ton calendrier." },
      ],
      tools: asTools(calendarListTool),
      permissions: [],
    });

    const { record } = await h.run();

    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]).toMatchObject({ status: "denied", errorCode: "PERMISSION_DENIED" });
    expect(JSON.stringify(h.llm.requests[1]?.messages.at(-1))).toContain("refusée");
  });

  it("laisse passer un outil dont la permission est accordée", async () => {
    const h = makeHarness({
      turns: [
        callTurn("calendar.list", { day: "demain" }),
        { kind: "final", text: "1 événement." },
      ],
      tools: asTools(calendarListTool),
      permissions: ["calendar.read"],
    });

    const { record } = await h.run();
    expect(record.toolsUsed[0]?.status).toBe("success");
  });

  it("accepte un joker de domaine", async () => {
    const h = makeHarness({
      turns: [callTurn("calendar.list", { day: "demain" }), { kind: "final", text: "ok" }],
      tools: asTools(calendarListTool),
      permissions: ["calendar.*"],
    });

    const { record } = await h.run();
    expect(record.toolsUsed[0]?.status).toBe("success");
  });
});

describe("confirmation", () => {
  it("suspend le run et expose la demande", async () => {
    const email = makeEmailTool();
    const h = makeHarness({
      turns: [callTurn("email.send", { to: "recruteur@x.com", subject: "Re", body: "Bonjour" })],
      tools: asTools(email.tool),
      permissions: ["email.send"],
    });

    const { record, confirmation } = await h.run();

    expect(record.status).toBe("waiting_for_confirmation");
    expect(record.endTime).toBeNull();
    expect(email.sent).toHaveLength(0);

    expect(confirmation).toBeDefined();
    expect(confirmation?.tool).toBe("email.send");
    expect(confirmation?.riskLevel).toBe("HIGH");
    expect(confirmation?.action).toBe("Envoyer un email à recruteur@x.com");
    // L'aperçu montre le contenu exact, pas un résumé produit par le modèle.
    expect(confirmation?.description).toContain("recruteur@x.com");
    expect(confirmation?.expiresAt.getTime()).toBeGreaterThan(confirmation!.createdAt.getTime());
  });

  it("exécute l'action après acceptation", async () => {
    const email = makeEmailTool();
    const h = makeHarness({
      turns: [
        callTurn("email.send", { to: "a@b.c", subject: "Sujet", body: "Corps" }),
        { kind: "final", text: "Email envoyé." },
      ],
      tools: asTools(email.tool),
      permissions: ["email.send"],
    });

    const first = await h.run();
    const resumed = await h.orchestrator.resume(first.record.runId, "approved");

    expect(resumed.record.status).toBe("completed");
    expect(resumed.record.response).toBe("Email envoyé.");
    expect(email.sent).toEqual([{ to: "a@b.c", subject: "Sujet", body: "Corps" }]);
    expect(resumed.record.toolsUsed.at(-1)).toMatchObject({
      name: "email.send",
      status: "success",
    });
  });

  it("n'exécute rien après un refus", async () => {
    const email = makeEmailTool();
    const h = makeHarness({
      turns: [
        callTurn("email.send", { to: "a@b.c", subject: "s", body: "b" }),
        { kind: "final", text: "D'accord, je n'envoie rien." },
      ],
      tools: asTools(email.tool),
      permissions: ["email.send"],
    });

    const first = await h.run();
    const resumed = await h.orchestrator.resume(first.record.runId, "rejected");

    expect(resumed.record.status).toBe("completed");
    expect(email.sent).toHaveLength(0);
    expect(resumed.record.toolsUsed.at(-1)?.status).toBe("rejected");
    // Le refus est réinjecté : l'agent doit pouvoir en accuser réception.
    expect(JSON.stringify(h.llm.requests.at(-1)?.messages.at(-1))).toContain("refusé");
  });

  it("impose une confirmation sur une action CRITICAL même si l'outil n'en demande pas", async () => {
    const h = makeHarness({
      turns: [callTurn("terminal.execute", { command: "rm -rf /" })],
      tools: asTools(dangerousTool),
      permissions: ["terminal.execute"],
    });

    const { record, confirmation } = await h.run();

    expect(record.status).toBe("waiting_for_confirmation");
    expect(confirmation?.riskLevel).toBe("CRITICAL");
  });

  it("fait dépendre la confirmation des arguments", async () => {
    const h = makeHarness({
      turns: [
        callTurn("filesystem.write", { path: "/home/adlan/dev/x.ts", content: "ok" }),
        { kind: "final", text: "Écrit." },
      ],
      tools: asTools(fileWriteTool),
      permissions: ["filesystem.write"],
      autoApproveMaxRisk: "MEDIUM",
    });

    const { record } = await h.run();

    // Dans la zone de travail : pas de confirmation.
    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]?.status).toBe("success");
  });

  it("demande une confirmation hors de la zone de travail", async () => {
    const h = makeHarness({
      turns: [callTurn("filesystem.write", { path: "/etc/hosts", content: "x" })],
      tools: asTools(fileWriteTool),
      permissions: ["filesystem.write"],
      autoApproveMaxRisk: "MEDIUM",
    });

    const { record } = await h.run();
    expect(record.status).toBe("waiting_for_confirmation");
  });

  it("refuse de reprendre un run qui n'attend rien", async () => {
    const h = makeHarness({ turns: [{ kind: "final", text: "ok" }] });
    const { record } = await h.run();

    await expect(h.orchestrator.resume(record.runId, "approved")).rejects.toThrow(
      /n'attend pas de confirmation/,
    );
  });
});

describe("budgets", () => {
  it("s'arrête sur le nombre maximal d'itérations avec un résultat partiel", async () => {
    const h = makeHarness({
      turns: Array.from({ length: 10 }, (_, i) =>
        callTurn("weather.get", { city: `ville-${String(i)}` }, `c${String(i)}`),
      ),
      policy: { maxIterations: 3 },
    });

    const { record } = await h.run();

    expect(record.status).toBe("incomplete");
    expect(record.stopReason).toBe("max_iterations");
    expect(record.iterations).toBe(3);
    // Un agent qui s'arrête sans rien dire est un défaut produit.
    expect(record.response).toContain("Effectué");
    expect(record.response).toContain("weather.get");
  });

  it("s'arrête sur le nombre maximal d'appels d'outils", async () => {
    const h = makeHarness({
      turns: Array.from({ length: 10 }, (_, i) =>
        callTurn("weather.get", { city: `v${String(i)}` }, `c${String(i)}`),
      ),
      policy: { maxToolCalls: 2, maxIterations: 20 },
    });

    const { record } = await h.run();

    expect(record.stopReason).toBe("max_tool_calls");
    expect(record.toolsUsed.filter((t) => t.status === "success")).toHaveLength(2);
  });

  it("bloque un outil rappelé indéfiniment avec les mêmes arguments", async () => {
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { city: "Paris" }, "c1"),
        callTurn("weather.get", { city: "Paris" }, "c2"),
        callTurn("weather.get", { city: "Paris" }, "c3"),
        { kind: "final", text: "J'arrête." },
      ],
      policy: { maxIdenticalToolCalls: 2 },
    });

    const { record } = await h.run();

    expect(record.toolsUsed.map((t) => t.status)).toEqual(["success", "success", "skipped"]);
    expect(record.errors.at(-1)?.code).toBe("TOOL_LOOP_DETECTED");
  });
});

describe("arguments malformés", () => {
  it("renvoie les erreurs de validation au modèle sans exécuter l'outil", async () => {
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { ville: "Paris" }), // mauvaise clé
        callTurn("weather.get", { city: "Paris" }, "c2"),
        { kind: "final", text: "21 °C." },
      ],
    });

    const { record } = await h.run();

    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]).toMatchObject({
      status: "failed",
      errorCode: "TOOL_INPUT_INVALID",
      attempts: 0,
    });
    expect(record.toolsUsed[1]?.status).toBe("success");

    const observation = JSON.stringify(h.llm.requests[1]?.messages.at(-1));
    expect(observation).toContain("Arguments invalides");
    expect(observation).toContain("city");
  });

  it("traite un nom d'outil inventé comme une observation", async () => {
    const h = makeHarness({
      turns: [
        callTurn("outil.imaginaire", { x: 1 }),
        { kind: "final", text: "Cet outil n'existe pas." },
      ],
    });

    const { record } = await h.run();

    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]?.errorCode).toBe("TOOL_NOT_FOUND");
    expect(JSON.stringify(h.llm.requests[1]?.messages.at(-1))).toContain("weather.get");
  });
});

describe("panne du fournisseur", () => {
  it("termine en échec sans laisser le run en cours", async () => {
    const h = makeHarness({
      turns: [{ kind: "error", error: new Error("503 upstream") }],
    });

    const { record } = await h.run();

    expect(record.status).toBe("failed");
    expect(record.stopReason).toBe("provider_error");
    expect(record.endTime).toBeTruthy();
    expect(record.errors).toHaveLength(1);
    expect(record.response).toContain("service de génération");
  });

  it("échoue proprement quand le modèle est appelé plus que prévu", async () => {
    // Script épuisé : le fournisseur scripté lève, la boucle l'attrape.
    const h = makeHarness({ turns: [callTurn("weather.get", { city: "Paris" })] });

    const { record } = await h.run();

    expect(record.status).toBe("failed");
    expect(record.toolsUsed[0]?.status).toBe("success");
  });
});

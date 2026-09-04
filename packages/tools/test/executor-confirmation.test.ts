import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConflictError, NotFoundError } from "@nexus/shared";
import { ToolExecutor, backoffDelay, type RetryPolicy } from "../src/executor.js";
import { RetryableToolError } from "../src/errors.js";
import { ConfirmationService, hashPayload } from "../src/confirmation-service.js";
import type { ToolContext, ToolDefinition } from "../src/definition.js";

const NO_JITTER: RetryPolicy = {
  attempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 1_000,
  factor: 2,
  jitter: false,
};

function baseContext(signal = new AbortController().signal): Omit<ToolContext, "attempt"> {
  return {
    runId: "run-1",
    userId: "user-1",
    conversationId: "conv-1",
    correlationId: "corr-1",
    signal,
    idempotencyKey: "key-1",
    onProgress: () => undefined,
  };
}

function makeExecutor(sleeps: number[]) {
  return new ToolExecutor({
    retry: NO_JITTER,
    defaultTimeoutMs: 200,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
}

const echoTool: ToolDefinition<{ value: string }, { echoed: string }> = {
  name: "echo",
  description: "Renvoie sa valeur.",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  riskLevel: "SAFE",
  requiredPermissions: [],
  requiresConfirmation: false,
  execute: (input) => Promise.resolve({ echoed: input.value }),
};

describe("backoffDelay", () => {
  it("croît de façon exponentielle", () => {
    expect(backoffDelay(1, NO_JITTER)).toBe(100);
    expect(backoffDelay(2, NO_JITTER)).toBe(200);
    expect(backoffDelay(3, NO_JITTER)).toBe(400);
  });

  it("plafonne", () => {
    expect(backoffDelay(10, NO_JITTER)).toBe(1_000);
  });

  it("applique un jitter dans la moitié haute de l'intervalle", () => {
    const policy = { ...NO_JITTER, jitter: true };
    // Le jitter désynchronise les clients sans effacer la croissance : le délai
    // reste borné par [capped/2, capped].
    expect(backoffDelay(2, policy, () => 0)).toBe(100);
    expect(backoffDelay(2, policy, () => 1)).toBe(200);
  });
});

describe("ToolExecutor", () => {
  it("valide les arguments avant d'exécuter", async () => {
    let called = false;
    const tool: ToolDefinition<{ value: string }, { echoed: string }> = {
      ...echoTool,
      execute: (input) => {
        called = true;
        return Promise.resolve({ echoed: input.value });
      },
    };

    const result = await makeExecutor([]).execute(tool, { value: 42 }, baseContext());

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOOL_INPUT_INVALID");
  });

  it("valide la sortie contre le schéma déclaré", async () => {
    const tool: ToolDefinition<{ value: string }, { echoed: string }> = {
      ...echoTool,
      execute: () => Promise.resolve({ echoed: 12 } as unknown as { echoed: string }),
    };

    const result = await makeExecutor([]).execute(tool, { value: "x" }, baseContext());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOOL_OUTPUT_INVALID");
  });

  it("renvoie la sortie validée et une projection pour le modèle", async () => {
    const result = await makeExecutor([]).execute(echoTool, { value: "bonjour" }, baseContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual({ echoed: "bonjour" });
      expect(result.summaryForModel).toContain("bonjour");
      expect(result.metrics.attempts).toBe(1);
    }
  });

  it("tronque une sortie volumineuse destinée au modèle", async () => {
    const tool: ToolDefinition<{ value: string }, { echoed: string }> = {
      ...echoTool,
      execute: () => Promise.resolve({ echoed: "x".repeat(50_000) }),
    };
    const executor = new ToolExecutor({ maxSummaryChars: 100, sleep: () => Promise.resolve() });

    const result = await executor.execute(tool, { value: "x" }, baseContext());

    // La sortie complète reste intacte ; seule la projection est bornée.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.echoed).toHaveLength(50_000);
      expect(result.summaryForModel.length).toBeLessThan(200);
      expect(result.summaryForModel).toContain("tronqué");
    }
  });

  it("réessaie un échec transitoire", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const tool: ToolDefinition<{ value: string }, { echoed: string }> = {
      ...echoTool,
      execute: (input) => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(new RetryableToolError("echo", { message: "429" }));
        }
        return Promise.resolve({ echoed: input.value });
      },
    };

    const result = await makeExecutor(sleeps).execute(tool, { value: "ok" }, baseContext());

    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("ne réessaie jamais un outil non idempotent", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const tool: ToolDefinition<{ value: string }, { echoed: string }> = {
      ...echoTool,
      idempotent: false,
      execute: () => {
        attempts += 1;
        return Promise.reject(new RetryableToolError("echo", { message: "503" }));
      },
    };

    const result = await makeExecutor(sleeps).execute(tool, { value: "x" }, baseContext());

    // On ne peut pas savoir si le premier appel a déjà produit son effet.
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("impose son délai à un outil qui ignore son signal", async () => {
    const tool: ToolDefinition<{ value: string }, { echoed: string }> = {
      ...echoTool,
      timeoutMs: 20,
      retry: { attempts: 1 },
      execute: () => new Promise(() => undefined),
    };

    const result = await makeExecutor([]).execute(tool, { value: "x" }, baseContext());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOOL_TIMEOUT");
  });

  it("distingue une annulation d'un délai dépassé", async () => {
    const controller = new AbortController();
    const tool: ToolDefinition<{ value: string }, { echoed: string }> = {
      ...echoTool,
      timeoutMs: 5_000,
      execute: () => new Promise(() => undefined),
    };

    const pending = makeExecutor([]).execute(tool, { value: "x" }, baseContext(controller.signal));
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOOL_CANCELLED");
  });

  it("n'exécute rien si le signal est déjà abandonné", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const tool: ToolDefinition<{ value: string }, { echoed: string }> = {
      ...echoTool,
      execute: (input) => {
        called = true;
        return Promise.resolve({ echoed: input.value });
      },
    };

    const result = await makeExecutor([]).execute(
      tool,
      { value: "x" },
      baseContext(controller.signal),
    );

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe("ConfirmationService", () => {
  const payload = { to: "a@b.c", subject: "Bonjour" };

  const makeService = (now: () => Date) =>
    new ConfirmationService({ now, ttlMs: 60_000, criticalTtlMs: 10_000 });

  const input = {
    runId: "run-1",
    userId: "user-1",
    tool: "email.send",
    toolCallId: "call-1",
    action: "Envoyer un email à a@b.c",
    description: "…",
    riskLevel: "HIGH" as const,
    payload,
  };

  it("crée une demande en attente", async () => {
    const service = makeService(() => new Date("2026-09-01T10:00:00Z"));
    const request = await service.request(input);

    expect(request.status).toBe("pending");
    expect(request.payloadHash).toBe(hashPayload(payload));
    expect(request.expiresAt.toISOString()).toBe("2026-09-01T10:01:00.000Z");
    expect(request.decidedAt).toBeNull();
  });

  it("raccourcit le délai des actions irréversibles", async () => {
    const service = makeService(() => new Date("2026-09-01T10:00:00Z"));
    const request = await service.request({ ...input, riskLevel: "CRITICAL" });

    // Une confirmation critique qui traîne n'a plus de sens : le contexte a changé.
    expect(request.expiresAt.toISOString()).toBe("2026-09-01T10:00:10.000Z");
  });

  it("enregistre une décision", async () => {
    const service = makeService(() => new Date("2026-09-01T10:00:00Z"));
    const request = await service.request(input);

    const approved = await service.resolve(request.id, "approved");
    expect(approved.status).toBe("approved");
    expect(approved.decidedAt).not.toBeNull();
  });

  it("empêche le rejeu d'une approbation", async () => {
    const service = makeService(() => new Date("2026-09-01T10:00:00Z"));
    const request = await service.request(input);
    await service.resolve(request.id, "approved");

    await expect(service.resolve(request.id, "approved")).rejects.toThrow(ConflictError);
  });

  it("n'auto-approuve jamais une demande expirée", async () => {
    let now = new Date("2026-09-01T10:00:00Z");
    const service = makeService(() => now);
    const request = await service.request(input);

    now = new Date("2026-09-01T10:05:00Z");

    expect((await service.get(request.id))?.status).toBe("expired");
    await expect(service.resolve(request.id, "approved")).rejects.toThrow(ConflictError);
  });

  it("lève sur une demande inconnue", async () => {
    const service = makeService(() => new Date());
    await expect(service.resolve("inexistant", "approved")).rejects.toThrow(NotFoundError);
  });

  it("lie la décision aux arguments exacts", async () => {
    const service = makeService(() => new Date("2026-09-01T10:00:00Z"));
    const request = await service.request(input);

    expect(service.matchesPayload(request, payload)).toBe(true);
    // Un seul caractère modifié après l'accord invalide l'autorisation :
    // c'est la protection contre le « bait and switch ».
    expect(service.matchesPayload(request, { ...payload, to: "attaquant@x.y" })).toBe(false);
  });

  it("produit une empreinte stable quel que soit l'ordre des clés", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
});

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConflictError } from "@nexus/shared";
import { ToolRegistry } from "../src/registry.js";
import { ToolNotFoundError } from "../src/errors.js";
import { missingPermissions, permissionCovers } from "../src/permissions.js";
import { maxRisk, riskAtLeast, riskRank } from "../src/risk.js";
import { PermissionService, StaticGrantProvider } from "../src/permission-service.js";
import type { ToolContext, ToolDefinition } from "../src/definition.js";

function makeTool(overrides: Partial<ToolDefinition<{ x?: string }, unknown>> = {}) {
  return {
    name: "test.tool",
    description: "Outil de test.",
    inputSchema: z.object({ x: z.string().optional() }),
    outputSchema: z.unknown(),
    riskLevel: "SAFE",
    requiredPermissions: [],
    requiresConfirmation: false,
    execute: () => Promise.resolve(null),
    ...overrides,
  } as ToolDefinition<{ x?: string }, unknown>;
}

const context: ToolContext = {
  runId: "run-1",
  userId: "user-1",
  conversationId: "conv-1",
  correlationId: "corr-1",
  signal: new AbortController().signal,
  idempotencyKey: "key-1",
  attempt: 1,
  onProgress: () => undefined,
};

describe("ToolRegistry", () => {
  it("enregistre, retrouve et supprime un outil", () => {
    const registry = new ToolRegistry();
    const tool = makeTool();

    expect(registry.has("test.tool")).toBe(false);
    registry.register(tool);

    expect(registry.has("test.tool")).toBe(true);
    expect(registry.get("test.tool")?.name).toBe("test.tool");
    expect(registry.list()).toHaveLength(1);
    expect(registry.size).toBe(1);

    expect(registry.unregister("test.tool")).toBe(true);
    expect(registry.unregister("test.tool")).toBe(false);
    expect(registry.get("test.tool")).toBeUndefined();
  });

  it("refuse un doublon silencieux", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());

    // Avec plusieurs sources d'outils, un remplacement silencieux serait une
    // source de bugs très pénible à diagnostiquer.
    expect(() => registry.register(makeTool())).toThrow(ConflictError);
    expect(() => registry.register(makeTool(), { replace: true })).not.toThrow();
  });

  it("lève une erreur explicite sur `require` d'un outil absent", () => {
    expect(() => new ToolRegistry().require("absent")).toThrow(ToolNotFoundError);
  });

  it("ne liste que les outils dont les permissions sont couvertes", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "libre", requiredPermissions: [] }));
    registry.register(makeTool({ name: "cal", requiredPermissions: ["calendar.read"] }));
    registry.register(makeTool({ name: "mail", requiredPermissions: ["email.send"] }));

    expect(registry.listAllowed([]).map((t) => t.name)).toEqual(["libre"]);
    expect(registry.listAllowed(["calendar.read"]).map((t) => t.name)).toEqual(["libre", "cal"]);
    expect(registry.listAllowed(["*"]).map((t) => t.name)).toEqual(["libre", "cal", "mail"]);
  });

  it("notifie les abonnés d'un changement de catalogue", () => {
    const registry = new ToolRegistry();
    const listener = vi.fn();
    const off = registry.onChange(listener);

    registry.register(makeTool());
    expect(listener).toHaveBeenCalledTimes(1);

    registry.unregister("test.tool");
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    registry.register(makeTool());
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("permissions", () => {
  it("couvre une permission exacte", () => {
    expect(permissionCovers("calendar.read", "calendar.read")).toBe(true);
    expect(permissionCovers("calendar.read", "calendar.write")).toBe(false);
  });

  it("couvre un domaine entier par joker", () => {
    expect(permissionCovers("calendar.*", "calendar.write")).toBe(true);
    expect(permissionCovers("calendar.*", "email.send")).toBe(false);
    expect(permissionCovers("*", "terminal.execute")).toBe(true);
  });

  it("liste ce qui manque", () => {
    expect(missingPermissions(["calendar.read"], ["calendar.read", "email.send"])).toEqual([
      "email.send",
    ]);
    expect(missingPermissions(["*"], ["a.b", "c.d"])).toEqual([]);
  });
});

describe("niveaux de risque", () => {
  it("est une échelle ordonnée", () => {
    expect(riskRank("SAFE")).toBeLessThan(riskRank("LOW"));
    expect(riskRank("MEDIUM")).toBeLessThan(riskRank("HIGH"));
    expect(riskRank("HIGH")).toBeLessThan(riskRank("CRITICAL"));
  });

  it("ne remonte que vers le haut", () => {
    expect(maxRisk("SAFE", "HIGH")).toBe("HIGH");
    expect(maxRisk("CRITICAL", "LOW")).toBe("CRITICAL");
    expect(riskAtLeast("MEDIUM", "LOW")).toBe(true);
    expect(riskAtLeast("LOW", "MEDIUM")).toBe(false);
  });
});

describe("PermissionService", () => {
  const service = (granted: string[], options?: { readOnly?: boolean }) =>
    new PermissionService({
      grants: new StaticGrantProvider(granted),
      autoApproveMaxRisk: "LOW",
      ...options,
    });

  it("autorise un outil SAFE sans permission requise", async () => {
    const decision = await service([]).check(makeTool(), {}, context);
    expect(decision.effect).toBe("allow");
  });

  it("refuse par défaut quand une permission manque", async () => {
    const tool = makeTool({ requiredPermissions: ["email.send"] });
    const decision = await service([]).check(tool, {}, context);

    expect(decision).toMatchObject({ effect: "deny", missing: ["email.send"] });
  });

  it("impose une confirmation au-dessus du seuil d'auto-approbation", async () => {
    const tool = makeTool({ riskLevel: "MEDIUM" });
    const decision = await service([]).check(tool, {}, context);

    expect(decision).toMatchObject({ effect: "confirm", riskLevel: "MEDIUM" });
  });

  it("impose toujours une confirmation sur CRITICAL, même si l'outil s'en dispense", async () => {
    const tool = makeTool({ riskLevel: "CRITICAL", requiresConfirmation: false });
    const decision = await service([]).check(tool, {}, context);

    expect(decision).toMatchObject({ effect: "confirm", riskLevel: "CRITICAL" });
  });

  it("évalue `requiresConfirmation` sur les arguments", async () => {
    const tool = makeTool({
      riskLevel: "SAFE",
      requiresConfirmation: (input) => input.x === "dangereux",
    });

    expect((await service([]).check(tool, { x: "ok" }, context)).effect).toBe("allow");
    expect((await service([]).check(tool, { x: "dangereux" }, context)).effect).toBe("confirm");
  });

  it("refuse tout au-dessus de SAFE en mode lecture seule", async () => {
    const readOnly = service(["*"], { readOnly: true });

    expect((await readOnly.check(makeTool({ riskLevel: "SAFE" }), {}, context)).effect).toBe(
      "allow",
    );
    expect((await readOnly.check(makeTool({ riskLevel: "LOW" }), {}, context)).effect).toBe("deny");
  });

  it("fait primer le refus de permission sur la confirmation", async () => {
    // L'ordre d'évaluation est le contrat : une action non autorisée ne doit
    // même pas être proposée à l'utilisateur.
    const tool = makeTool({ riskLevel: "CRITICAL", requiredPermissions: ["terminal.execute"] });
    const decision = await service([]).check(tool, {}, context);

    expect(decision.effect).toBe("deny");
  });
});

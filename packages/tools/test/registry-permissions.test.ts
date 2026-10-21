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
    description: "Test tool.",
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
  it("registers, retrieves, and unregisters tools", () => {
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

  it("rejects silent duplicates", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());

    expect(() => registry.register(makeTool())).toThrow(ConflictError);
    expect(() => registry.register(makeTool(), { replace: true })).not.toThrow();
  });

  it("throws explicit error when requiring missing tool", () => {
    expect(() => new ToolRegistry().require("missing")).toThrow(ToolNotFoundError);
  });

  it("lists only tools whose required permissions are covered", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "free", requiredPermissions: [] }));
    registry.register(makeTool({ name: "cal", requiredPermissions: ["calendar.read"] }));
    registry.register(makeTool({ name: "mail", requiredPermissions: ["email.send"] }));

    expect(registry.listAllowed([]).map((t) => t.name)).toEqual(["free"]);
    expect(registry.listAllowed(["calendar.read"]).map((t) => t.name)).toEqual(["free", "cal"]);
    expect(registry.listAllowed(["*"]).map((t) => t.name)).toEqual(["free", "cal", "mail"]);
  });

  it("notifies listeners on registry mutations", () => {
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
  it("covers exact permissions", () => {
    expect(permissionCovers("calendar.read", "calendar.read")).toBe(true);
    expect(permissionCovers("calendar.read", "calendar.write")).toBe(false);
  });

  it("covers domain wildcards", () => {
    expect(permissionCovers("calendar.*", "calendar.write")).toBe(true);
    expect(permissionCovers("calendar.*", "email.send")).toBe(false);
    expect(permissionCovers("*", "terminal.execute")).toBe(true);
  });

  it("identifies missing permissions", () => {
    expect(missingPermissions(["calendar.read"], ["calendar.read", "email.send"])).toEqual([
      "email.send",
    ]);
    expect(missingPermissions(["*"], ["a.b", "c.d"])).toEqual([]);
  });
});

describe("risk levels", () => {
  it("forms an ordered risk rank scale", () => {
    expect(riskRank("SAFE")).toBeLessThan(riskRank("LOW"));
    expect(riskRank("LOW")).toBeLessThan(riskRank("MEDIUM"));
    expect(riskRank("MEDIUM")).toBeLessThan(riskRank("HIGH"));
    expect(riskRank("HIGH")).toBeLessThan(riskRank("CRITICAL"));
  });

  it("escalates upwards strictly", () => {
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

  it("authorizes SAFE tool without required permissions", async () => {
    const decision = await service([]).check(makeTool(), {}, context);
    expect(decision.effect).toBe("allow");
  });

  it("denies by default when permission is missing", async () => {
    const tool = makeTool({ requiredPermissions: ["email.send"] });
    const decision = await service([]).check(tool, {}, context);

    expect(decision).toMatchObject({ effect: "deny", missing: ["email.send"] });
  });

  it("enforces confirmation above auto-approve threshold", async () => {
    const tool = makeTool({ riskLevel: "MEDIUM" });
    const decision = await service([]).check(tool, {}, context);

    expect(decision).toMatchObject({ effect: "confirm", riskLevel: "MEDIUM" });
  });

  it("always enforces confirmation on CRITICAL actions", async () => {
    const tool = makeTool({ riskLevel: "CRITICAL", requiresConfirmation: false });
    const decision = await service([]).check(tool, {}, context);

    expect(decision).toMatchObject({ effect: "confirm", riskLevel: "CRITICAL" });
  });

  it("evaluates dynamic confirmation on arguments", async () => {
    const tool = makeTool({
      riskLevel: "SAFE",
      requiresConfirmation: (input) => input.x === "dangerous",
    });

    expect((await service([]).check(tool, { x: "ok" }, context)).effect).toBe("allow");
    expect((await service([]).check(tool, { x: "dangerous" }, context)).effect).toBe("confirm");
  });

  it("denies actions above SAFE in read-only mode", async () => {
    const readOnly = service(["*"], { readOnly: true });

    expect((await readOnly.check(makeTool({ riskLevel: "SAFE" }), {}, context)).effect).toBe(
      "allow",
    );
    expect((await readOnly.check(makeTool({ riskLevel: "LOW" }), {}, context)).effect).toBe("deny");
  });

  it("prioritizes permission denial over confirmation requirement", async () => {
    const tool = makeTool({ riskLevel: "CRITICAL", requiredPermissions: ["terminal.execute"] });
    const decision = await service([]).check(tool, {}, context);

    expect(decision.effect).toBe("deny");
  });
});

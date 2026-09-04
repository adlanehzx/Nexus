import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REDACTED } from "@nexus/shared";
import type { ToolDefinition } from "@nexus/tools";
import { callTurn, makeHarness } from "./fixtures.js";

describe("secrets dans la trace d'un run", () => {
  it("ne consigne jamais les arguments sensibles d'un outil", async () => {
    const loginTool: ToolDefinition<{ user: string; password: string }, { ok: boolean }> = {
      name: "site.login",
      description: "Se connecte à un site.",
      inputSchema: z.object({ user: z.string(), password: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      riskLevel: "SAFE",
      requiredPermissions: [],
      requiresConfirmation: false,
      execute: () => Promise.resolve({ ok: true }),
    };

    const h = makeHarness({
      turns: [
        callTurn("site.login", { user: "adlan", password: "hunter2" }),
        { kind: "final", text: "Connecté." },
      ],
      tools: [loginTool] as unknown as ToolDefinition<never, unknown>[],
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]?.input).toEqual({ user: "adlan", password: REDACTED });
    expect(JSON.stringify(record)).not.toContain("hunter2");
    // Les événements sont destinés à être journalisés et transmis : ils sont
    // soumis à la même règle.
    expect(JSON.stringify(h.events)).not.toContain("hunter2");
  });
});

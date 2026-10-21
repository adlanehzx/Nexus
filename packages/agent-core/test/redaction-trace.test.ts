import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REDACTED } from "@nexus/shared";
import type { ToolDefinition } from "@nexus/tools";
import { callTurn, makeHarness } from "./fixtures.js";

describe("run trace secret redaction", () => {
  it("never logs sensitive tool arguments", async () => {
    const loginTool: ToolDefinition<{ user: string; password: string }, { ok: boolean }> = {
      name: "site.login",
      description: "Logs into a website.",
      inputSchema: z.object({ user: z.string(), password: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      riskLevel: "SAFE",
      requiredPermissions: [],
      requiresConfirmation: false,
      execute: () => Promise.resolve({ ok: true }),
    };

    const h = makeHarness({
      turns: [
        callTurn("site.login", { user: "example", password: "hunter2" }),
        { kind: "final", text: "Connected." },
      ],
      tools: [loginTool] as unknown as ToolDefinition<never, unknown>[],
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]?.input).toEqual({ user: "example", password: REDACTED });
    expect(JSON.stringify(record)).not.toContain("hunter2");
    expect(JSON.stringify(h.events)).not.toContain("hunter2");
  });
});

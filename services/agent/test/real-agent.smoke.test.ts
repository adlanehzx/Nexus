import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runAcp } from "../src/runner.js";

/**
 * Opt-in smoke test against one provider's real ACP adapter and existing local session.
 *
 * This test is disabled unless every required variable is provided because it can
 * consume a provider subscription allowance. It never prints the model response or
 * any provider environment value.
 */
const enabled = process.env.NEXUS_REAL_AGENT_CONVERSATION === "1";
const live = enabled ? describe : describe.skip;

live("real ACP provider conversation", () => {
  it("returns a non-empty effective model response", { timeout: 180_000 }, async () => {
    const profile = process.env.NEXUS_REAL_AGENT_PROFILE;
    const registry = process.env.NEXUS_REAL_AGENT_REGISTRY;
    const workspace = process.env.NEXUS_REAL_AGENT_WORKSPACE ?? process.cwd();

    if (profile === undefined || profile.trim() === "") {
      throw new Error("missing_NEXUS_REAL_AGENT_PROFILE");
    }
    if (registry === undefined || registry.trim() === "") {
      throw new Error("missing_NEXUS_REAL_AGENT_REGISTRY");
    }

    const result = await runAcp({
      profile,
      registryPath: await realpath(resolve(registry)),
      cwd: await realpath(resolve(workspace)),
      prompt:
        "Reply with a short confirmation that the NEXUS ACP smoke test works. Do not use tools.",
    });

    expect(result.response.trim().length).toBeGreaterThan(0);
    expect(result.stopReason.trim().length).toBeGreaterThan(0);
    expect(result.response).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(result.response).not.toMatch(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{16,}/);
  });
});

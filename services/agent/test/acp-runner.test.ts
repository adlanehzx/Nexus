import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runAcp } from "../src/runner.js";

describe("Deterministic Fake ACP Provider Contract", () => {
  it("streams real response chunks without external quota and sanitizes errors", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "nexus-acp-test-"));
    const agentScript = resolve(__dirname, "../scripts/e2e-acp-agent.mjs");
    const registryPath = join(tmpDir, "profiles.json");

    await writeFile(
      registryPath,
      JSON.stringify({
        profiles: {
          "fake-acp": {
            command: process.execPath,
            args: [agentScript, "--mode", "succeed", "--marker", "ci-test-42"],
            system_prompt: "Deterministic CI fake agent.",
            additional_dirs: [],
          },
          "fake-review": {
            command: process.execPath,
            args: [agentScript, "--mode", "review", "--marker", "review-42"],
            additional_dirs: [],
          },
          "fake-crash": {
            command: process.execPath,
            args: [agentScript, "--mode", "crash", "--marker", "crash-42"],
            additional_dirs: [],
          },
        },
      }),
      { mode: 0o600 },
    );

    const result = await runAcp({
      profile: "fake-acp",
      cwd: tmpDir,
      prompt: "Execute deterministic mission",
      registryPath,
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.response).toContain("MARKER=ci-test-42");
    expect(result.response).toContain("PERMISSION=allowed");

    // Review mode returning structured JSON
    const reviewResult = await runAcp({
      profile: "fake-review",
      cwd: tmpDir,
      prompt: "Review mission quality",
      registryPath,
    });

    expect(reviewResult.stopReason).toBe("end_turn");
    const parsedReview = JSON.parse(reviewResult.response) as { verdict: string };
    expect(parsedReview.verdict).toBe("pass");

    // Transport crash handling / sanitized error taxonomy
    await expect(
      runAcp({
        profile: "fake-crash",
        cwd: tmpDir,
        prompt: "Will crash",
        registryPath,
      }),
    ).rejects.toThrow("agent_transport");

    await rm(tmpDir, { recursive: true, force: true });
  });
});

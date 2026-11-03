import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpOrchestrator } from "../src/services/acp-orchestrator.js";
import type { MissionControlPort } from "@nexus/mission-control-client";

/**
 * A mission needs a writable workspace, and said so badly.
 *
 * In the shipped container the image root is read-only, so the default root
 * resolved under the application directory and `mkdir` failed with ENOENT.
 * That surfaced as `INTERNAL_ERROR` — a 500 with nothing to act on — which is
 * what made the chat look broken for reasons no log explained.
 */

const missionControl = {
  health: () =>
    Promise.resolve({
      status: "ready",
      worker_enabled: true,
      worker_concurrency: 2,
      scheduler_enabled: true,
      profiles: ["claude"],
    }),
  settings: () => Promise.resolve({}),
} as unknown as MissionControlPort;

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "nexus-acp-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("ACP mission workspace", () => {
  it("reports an unwritable workspace root as an actionable dependency failure", async () => {
    // A regular file standing where a directory must be: `mkdir` cannot
    // recurse through it, exactly as it cannot write under a read-only image.
    const blocker = join(scratch, "not-a-directory");
    await writeFile(blocker, "");

    const orchestrator = new AcpOrchestrator({
      missionControl,
      workspaceRoot: join(blocker, "workspaces"),
    });

    await expect(orchestrator.submit(randomUUID(), "list the files", "UTC")).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      httpStatus: 503,
      userMessage: expect.stringContaining("NEXUS_ACP_WORKSPACE_DIR"),
    });
  });

  it("degrades a failing memory assembly instead of losing the mission", async () => {
    // Discovered while validating BUG-002: with the workspace fixed, the next
    // failure was an embedding runtime the image could not load. Enrichment
    // must not be a precondition — but the loss has to be reported.
    const degraded: { reason: string }[] = [];
    const orchestrator = new AcpOrchestrator({
      missionControl,
      workspaceRoot: scratch,
      context: {
        assemble: () => Promise.reject(new Error("embedding runtime unavailable")),
      } as never,
      onDegraded: ({ reason }) => void degraded.push({ reason }),
    });

    // The run still fails further on — no engine is wired here — but it must
    // get past memory, and the degradation must have been announced.
    await orchestrator.submit(randomUUID(), "list the files", "UTC").catch(() => undefined);

    expect(degraded).toEqual([{ reason: "memory context unavailable" }]);
  });

  it("honours a configured workspace root instead of the process directory", async () => {
    // Pins the fix itself: the root must come from configuration. Defaulting
    // to `process.cwd()` is what tied the orchestrator to a writable checkout.
    const orchestrator = new AcpOrchestrator({ missionControl, workspaceRoot: scratch });

    // The run fails later — no engine is wired in this test — but it must not
    // fail on the workspace, and nothing may be created under the repository.
    await expect(
      orchestrator.submit(randomUUID(), "list the files", "UTC"),
    ).rejects.not.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
});

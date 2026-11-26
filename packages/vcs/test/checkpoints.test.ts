import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";
import { CheckpointManager, createCheckpointToolDefinitions } from "../src/index.js";

describe("Unified Checkpoints & Rollback Architecture", () => {
  const tmpDir = os.tmpdir();

  it("rejects capture outside Git instead of inventing a restorable snapshot", async () => {
    const manager = new CheckpointManager();
    await expect(
      manager.captureCheckpoint({ threadId: "test-thread-99", turnNumber: 1, cwd: tmpDir }),
    ).rejects.toThrow("Git repository");
    expect(await manager.listCheckpoints("test-thread-99")).toEqual([]);
  });

  it("registers checkpoint tools and executes checkpoint creation tool", async () => {
    const mockManager = {
      captureCheckpoint: vi.fn().mockResolvedValue({
        id: "a0000000-0000-4000-8000-000000000001",
        threadId: "thread-10",
        turnNumber: 3,
        description: "Added feature",
        createdAt: new Date().toISOString(),
      }),
      restoreCheckpoint: vi.fn().mockResolvedValue({
        success: true,
        threadId: "thread-10",
        checkpointId: "a0000000-0000-4000-8000-000000000001",
        rolledBackFiles: ["src/index.ts"],
        timestamp: new Date().toISOString(),
      }),
      getTurnDiff: vi.fn().mockResolvedValue({
        threadId: "thread-10",
        fromTurnCount: 1,
        toTurnCount: 3,
        filesChanged: ["src/index.ts"],
        insertions: 10,
        deletions: 2,
        diff: "@@ -1 +1 @@\n-old\n+new",
      }),
    } as unknown as CheckpointManager;

    const tools = createCheckpointToolDefinitions(mockManager);
    expect(tools.length).toBe(3);

    const createTool = tools.find((t) => t.name === "checkpoint_create");
    expect(createTool).toBeDefined();
    const resCreate = await createTool!.execute(
      {
        threadId: "thread-10",
        turnNumber: 3,
        cwd: tmpDir,
        description: "Added feature",
      },
      {} as never,
    );
    expect(resCreate).toEqual({
      checkpoint: expect.objectContaining({ turnNumber: 3 }),
    });

    const rollbackTool = tools.find((t) => t.name === "checkpoint_rollback");
    expect(rollbackTool).toBeDefined();
    expect(rollbackTool!.requiresConfirmation).toBe(true);
    expect(rollbackTool!.riskLevel).toBe("HIGH");

    const resRollback = await rollbackTool!.execute(
      {
        threadId: "thread-10",
        turnNumber: 2,
        cwd: tmpDir,
        dryRun: false,
      },
      {} as never,
    );
    expect(resRollback).toEqual({
      result: expect.objectContaining({ success: true, threadId: "thread-10" }),
    });

    const diffTool = tools.find((t) => t.name === "checkpoint_diff");
    expect(diffTool).toBeDefined();
    const resDiff = await diffTool!.execute(
      {
        threadId: "thread-10",
        fromTurn: 1,
        toTurn: 3,
        cwd: tmpDir,
      },
      {} as never,
    );
    expect(resDiff).toEqual({
      turnDiff: expect.objectContaining({ filesChanged: ["src/index.ts"], insertions: 10 }),
    });
  });
});

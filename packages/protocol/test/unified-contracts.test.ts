import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  SourceControlLinkSchema,
  WorktreeSchema,
  CheckpointSchema,
  AgentProviderConfigSchema,
  TelemetryReportSchema,
  TurnCountRangeSchema,
} from "../src/index.js";

describe("Unified Protocol Contracts", () => {
  it("validates SourceControlLinkSchema correctly", () => {
    const validLink = {
      id: randomUUID(),
      provider: "github",
      repoUrl: "https://github.com/adlanehzx/Nexus",
      pullRequestNumber: 42,
      branch: "feat/deep-fusion",
      headSha: "abcdef1234567890",
      checksState: "success",
      reviewState: "approved",
      watched: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const parsed = SourceControlLinkSchema.parse(validLink);
    expect(parsed.provider).toBe("github");
    expect(parsed.checksState).toBe("success");
  });

  it("validates WorktreeSchema correctly", () => {
    const validWorktree = {
      id: randomUUID(),
      path: "/home/nexus/workspace/worktrees/agent-1",
      branch: "agent/worktree-1",
      workspaceRoot: "/home/nexus/workspace",
      strategy: "isolated",
      status: "active",
      isDetached: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const parsed = WorktreeSchema.parse(validWorktree);
    expect(parsed.strategy).toBe("isolated");
    expect(parsed.status).toBe("active");
  });

  it("validates CheckpointSchema correctly", () => {
    const validCheckpoint = {
      id: randomUUID(),
      threadId: "thread-abc-123",
      turnNumber: 5,
      commitHash: "1234567890abcdef",
      diffBlob: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      description: "Implemented parser",
      createdAt: new Date().toISOString(),
    };
    const parsed = CheckpointSchema.parse(validCheckpoint);
    expect(parsed.turnNumber).toBe(5);
    expect(parsed.diffBlob).toContain("+new");
  });

  it("enforces turn count range constraints", () => {
    expect(() => TurnCountRangeSchema.parse({ fromTurnCount: 5, toTurnCount: 2 })).toThrow();
    expect(TurnCountRangeSchema.parse({ fromTurnCount: 2, toTurnCount: 5 })).toEqual({
      fromTurnCount: 2,
      toTurnCount: 5,
    });
  });

  it("validates AgentProviderConfigSchema correctly", () => {
    const validConfig = {
      id: randomUUID(),
      providerType: "claude",
      modelId: "claude-3-7-sonnet-20250219",
      isDefault: true,
      settings: { temperature: 0.7 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const parsed = AgentProviderConfigSchema.parse(validConfig);
    expect(parsed.providerType).toBe("claude");
    expect(parsed.isDefault).toBe(true);
  });

  it("validates TelemetryReportSchema correctly", () => {
    const validReport = {
      hostId: "host-node-01",
      agentInstanceId: "agent-session-42",
      metrics: [
        {
          pid: 1234,
          processName: "nexus-agent",
          cpuPercent: 12.5,
          memoryBytes: 104857600,
          timestamp: new Date().toISOString(),
        },
      ],
      systemCpuUsagePercent: 25.0,
      systemMemoryTotalBytes: 16000000000,
      systemMemoryFreeBytes: 8000000000,
      recordedAt: new Date().toISOString(),
    };
    const parsed = TelemetryReportSchema.parse(validReport);
    expect(parsed.metrics.length).toBe(1);
    expect(parsed.metrics[0]?.cpuPercent).toBe(12.5);
  });
});

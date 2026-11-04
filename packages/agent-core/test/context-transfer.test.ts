import { describe, it, expect } from "vitest";
import {
  ContextTransferService,
  type CanonicalHandoffContext,
} from "../src/index.js";

describe("Cross-Provider Context Transfer & Handoff (LOT E)", () => {
  it("adapts context preserving Git checkpoint, artifacts, short-term facts, and provenance", () => {
    const service = new ContextTransferService();

    const canonical: CanonicalHandoffContext = {
      threadId: "thread-transfer-1",
      originProvider: "claude",
      originModel: "claude-3-7-sonnet-20250219",
      targetProvider: "codex",
      targetModel: "o3-mini",
      systemPrompt: "You are an autonomous senior developer.",
      gitCheckpoint: {
        commitHash: "9a8b7c6d5e4f",
        branch: "feat/perf-cache",
        worktreePath: "/tmp/worktrees/agent-123",
      },
      artifacts: [
        {
          path: "docs/spec.md",
          summary: "API architecture specification",
          hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      ],
      shortTermMemory: {
        "Database Engine": "PostgreSQL 16",
        "Cache Strategy": "Write-through in Redis",
      },
      turns: [
        {
          turnNumber: 1,
          role: "user",
          content: "Please build the caching layer.",
          providerOrigin: "claude",
          timestamp: "2026-11-04T12:00:00Z",
        },
        {
          turnNumber: 2,
          role: "assistant",
          content: "I will first inspect the existing Redis configuration.",
          providerOrigin: "claude",
          timestamp: "2026-11-04T12:01:00Z",
        },
        {
          turnNumber: 3,
          role: "assistant",
          content: "Now implementing the client wrapper.",
          providerOrigin: "codex",
          timestamp: "2026-11-04T12:05:00Z",
        },
      ],
    };

    const adapted = service.adaptForTarget(canonical, 32000);

    // Verify preamble
    expect(adapted.systemPrompt).toContain("You are an autonomous senior developer.");
    expect(adapted.systemPrompt).toContain("9a8b7c6d5e4f");
    expect(adapted.systemPrompt).toContain("docs/spec.md");
    expect(adapted.systemPrompt).toContain("PostgreSQL 16");
    expect(adapted.systemPrompt).toContain("Write-through in Redis");
    expect(adapted.systemPrompt).toContain("Transferred from: claude");
    expect(adapted.systemPrompt).toContain("Active Provider: codex");

    // Verify provenance preservation
    expect(adapted.messages).toHaveLength(3);
    const m1Text = (adapted.messages[1]?.content[0] as { text: string }).text;
    const m2Text = (adapted.messages[2]?.content[0] as { text: string }).text;
    expect(m1Text).toContain("[Turn 2 via claude]");
    expect(m2Text).toContain("[Turn 3 via codex]");

    expect(adapted.preservedProvenance.providerCounts).toEqual({
      claude: 2,
      codex: 1,
    });
  });

  it("truncates middle turns when target context window is constrained while keeping initial goal", () => {
    const service = new ContextTransferService();

    // Create 20 turns
    const turns = Array.from({ length: 20 }, (_, idx) => ({
      turnNumber: idx + 1,
      role: idx % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Turn content ${idx + 1}: ${"x".repeat(400)}`, // ~100 tokens each
      providerOrigin: "claude" as const,
      timestamp: "2026-11-04T12:00:00Z",
    }));

    const canonical: CanonicalHandoffContext = {
      threadId: "thread-constrained",
      originProvider: "claude",
      originModel: "claude-3-7-sonnet-20250219",
      targetProvider: "pi",
      targetModel: "pi-inflection-2.5",
      systemPrompt: "Concise assistant.",
      turns,
      artifacts: [],
      shortTermMemory: {},
    };

    // Constrain context to very small budget (~1500 tokens total)
    const adapted = service.adaptForTarget(canonical, 2500);

    expect(adapted.truncatedTurnCount).toBeGreaterThan(0);
    // Turn 1 (initial user goal) must ALWAYS be preserved
    const firstText = (adapted.messages[0]?.content[0] as { text: string }).text;
    const lastText = (adapted.messages[adapted.messages.length - 1]?.content[0] as { text: string }).text;
    expect(firstText).toContain("Turn content 1:");
    // Most recent turn must also be preserved
    expect(lastText).toContain("Turn content 20:");
  });
});

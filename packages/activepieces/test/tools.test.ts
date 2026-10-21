import { describe, expect, it, vi } from "vitest";
import { createActivepiecesTools } from "../src/tools.js";
import type { ActivepiecesBridgeClient } from "../src/client.js";
import type { ToolContext, ToolDefinition } from "@nexus/tools";

describe("Activepieces tools for NEXUS agents", () => {
  const createMockContext = (): ToolContext => ({
    runId: "run-ap-1",
    userId: "user-1",
    conversationId: "conv-1",
    correlationId: "corr-1",
    signal: new AbortController().signal,
    idempotencyKey: "idem-ap",
    attempt: 1,
    onProgress: vi.fn(),
  });

  const mockClient: Partial<ActivepiecesBridgeClient> = {
    listFlows: vi.fn().mockResolvedValue([{ id: "f1", name: "Backup Notion", status: "ENABLED" }]),
    triggerFlow: vi.fn().mockResolvedValue({
      runId: "run-101",
      flowId: "f1",
      status: "SUCCEEDED",
      output: { ok: true },
    }),
    executePieceAction: vi.fn().mockResolvedValue({
      success: true,
      pieceName: "slack",
      actionName: "send_message",
      output: { id: "msg-1" },
    }),
    getRun: vi.fn().mockResolvedValue({
      runId: "run-101",
      flowId: "f1",
      status: "SUCCEEDED",
    }),
  };

  const tools = createActivepiecesTools({
    client: mockClient as unknown as ActivepiecesBridgeClient,
  });

  it("registers all 4 tools with correct permissions", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("activepieces.list_flows");
    expect(names).toContain("activepieces.trigger_flow");
    expect(names).toContain("activepieces.execute_action");
    expect(names).toContain("activepieces.get_run");
  });

  it("requires human confirmation on sensitive SaaS actions", () => {
    const actionTool = tools.find((t) => t.name === "activepieces.execute_action")!;
    expect(typeof actionTool.requiresConfirmation).toBe("function");

    if (typeof actionTool.requiresConfirmation === "function") {
      const isSensitive = actionTool.requiresConfirmation(
        {
          pieceName: "slack",
          actionName: "send_message",
          input: { channel: "#general" },
        } as never,
        createMockContext(),
      );
      expect(isSensitive).toBe(true);

      const isSafe = actionTool.requiresConfirmation(
        {
          pieceName: "notion",
          actionName: "get_page",
          input: { pageId: "page-123" },
        } as never,
        createMockContext(),
      );
      expect(isSafe).toBe(false);
    }
  });

  it("executes execute_action and provides clear human confirmation summary", async () => {
    const rawTool = tools.find((t) => t.name === "activepieces.execute_action")!;
    const actionTool = rawTool as unknown as ToolDefinition<
      { pieceName: string; actionName: string; input: Record<string, unknown> },
      { success: boolean }
    >;

    const input = {
      pieceName: "slack",
      actionName: "send_message",
      input: { channel: "#general", text: "System alert" },
    };

    const summary = actionTool.summarize?.(input);
    expect(summary).toBe('Send Slack message to channel "#general"');

    const ctx = createMockContext();
    const result = await actionTool.execute(input, ctx);
    expect(result.success).toBe(true);
    expect(mockClient.executePieceAction).toHaveBeenCalled();
  });
});

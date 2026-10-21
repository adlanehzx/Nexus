import { describe, expect, it, vi } from "vitest";
import { ActivepiecesBridgeClient } from "../src/client.js";

describe("Local Activepieces bridge client", () => {
  it("lists configured flows", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [
            {
              id: "flow-1",
              version: { displayName: "Slack Notification" },
              status: "ENABLED",
              updated: "2026-10-21T00:00:00Z",
            },
          ],
        }),
    });

    const client = new ActivepiecesBridgeClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "ap-key-123",
      fetchFn: mockFetch,
    });

    const flows = await client.listFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]?.id).toBe("flow-1");
    expect(flows[0]?.name).toBe("Slack Notification");
    expect(flows[0]?.status).toBe("ENABLED");
    expect(flows[0]?.webhookUrl).toBe("http://127.0.0.1:8080/api/v1/webhooks/flow-1");
  });

  it("triggers a flow via its webhook and returns the run", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/webhooks/flow-sync")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              runId: "run-abc",
              status: "SUCCEEDED",
              output: { success: true, count: 42 },
            }),
        });
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const client = new ActivepiecesBridgeClient({
      apiKey: "ap-key-123",
      fetchFn: mockFetch,
    });

    const result = await client.triggerFlow({
      flowId: "flow-sync",
      payload: { query: "sync data" },
    });

    expect(result.runId).toBe("run-abc");
    expect(result.status).toBe("SUCCEEDED");
    expect(result.output).toEqual({ success: true, count: 42 });
  });

  it("executes a direct action on a SaaS piece", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          success: true,
          output: { messageId: "msg-999" },
        }),
    });

    const client = new ActivepiecesBridgeClient({
      apiKey: "ap-key-123",
      fetchFn: mockFetch,
    });

    const actionResult = await client.executePieceAction({
      pieceName: "slack",
      actionName: "send_channel_message",
      input: { channel: "#general", text: "NEXUS Alert" },
    });

    expect(actionResult.success).toBe(true);
    expect(actionResult.pieceName).toBe("slack");
    expect(actionResult.output).toEqual({ messageId: "msg-999" });
  });
});

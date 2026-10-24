import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@nexus/tools";
import {
  N8nClient,
  ALL_SAAS_TOOLS,
  slackReadMessagesTool,
  slackPostMessageTool,
  gdriveListFilesTool,
  gdriveUploadFileTool,
  linearCreateIssueTool,
  SignedWebhookVerifier,
  WebhookSecurityError,
  SharedWorkflowEngine,
} from "../src/index.js";

const createMockContext = (): ToolContext => ({
  runId: "run-test-1",
  userId: "user-1",
  conversationId: "conv-1",
  correlationId: "corr-1",
  signal: new AbortController().signal,
  idempotencyKey: "idem-1",
  attempt: 1,
  onProgress: vi.fn(),
});

describe("CLA2: External Automation Ecosystem", () => {
  describe("n8n Automation Alternative", () => {
    it("validates config and rejects non-vault credentials", () => {
      expect(() => {
        new N8nClient(
          {
            baseUrl: "http://127.0.0.1:5678",
            apiKeyRef: "plain-secret-key", // Not a vault ref!
          },
          async () => {
            await Promise.resolve();
            return "resolved";
          },
        );
      }).toThrow();
    });

    it("triggers n8n webhook with payload", async () => {
      let fetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        await Promise.resolve();
        fetchCalled = true;
        return new Response(JSON.stringify({ status: "ok", executionId: "exec-99" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      try {
        const client = new N8nClient(
          {
            baseUrl: "http://127.0.0.1:5678",
            apiKeyRef: "vault://nexus/n8n/key",
          },
          async () => {
            await Promise.resolve();
            return "test-token";
          },
        );

        const res = await client.triggerWebhook("test-webhook", { action: "sync" });
        expect(res.success).toBe(true);
        expect(fetchCalled).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Typed SaaS Connectors & Read/Write Scope Segregation", () => {
    it("ensures all SaaS tools declare explicit risk levels and required permissions", () => {
      expect(ALL_SAAS_TOOLS.length).toBeGreaterThanOrEqual(14);
      for (const tool of ALL_SAAS_TOOLS) {
        expect(tool.name).toBeDefined();
        expect(tool.riskLevel).toBeDefined();
        expect(tool.requiredPermissions.length).toBeGreaterThan(0);
        expect(tool.summarize).toBeDefined();
      }
    });

    it("distinguishes read-only SAFE tools from mutable confirmed write tools", () => {
      // Slack read
      expect(slackReadMessagesTool.riskLevel).toBe("SAFE");
      expect(slackReadMessagesTool.requiresConfirmation).toBe(false);
      expect(slackReadMessagesTool.requiredPermissions).toEqual(["slack.read"]);

      // Slack write
      expect(slackPostMessageTool.riskLevel).toBe("MEDIUM");
      expect(slackPostMessageTool.requiresConfirmation).toBe(true);
      expect(slackPostMessageTool.requiredPermissions).toEqual(["slack.write"]);

      // Google Drive read vs write
      expect(gdriveListFilesTool.riskLevel).toBe("SAFE");
      expect(gdriveListFilesTool.requiresConfirmation).toBe(false);

      expect(gdriveUploadFileTool.riskLevel).toBe("MEDIUM");
      expect(gdriveUploadFileTool.requiresConfirmation).toBe(true);

      // Linear write
      expect(linearCreateIssueTool.riskLevel).toBe("MEDIUM");
      expect(linearCreateIssueTool.requiresConfirmation).toBe(true);
    });

    it("executes read tools without external side effect", async () => {
      const res = await slackReadMessagesTool.execute(
        { channelId: "C12345", limit: 5, vaultRef: "vault://nexus/slack/bot_token" },
        createMockContext(),
      );
      expect(res.messages.length).toBeGreaterThan(0);
    });
  });

  describe("Signed, Replay-Protected External Webhooks", () => {
    const secret = "super-secret-webhook-signing-key-32ch";
    const verifier = new SignedWebhookVerifier({ secret, toleranceSeconds: 60 });

    it("verifies valid HMAC-SHA256 signature header", () => {
      const payload = JSON.stringify({ event: "order_created", orderId: "ord-42" });
      const { signatureHeader, nonce, timestamp } = verifier.signPayload(payload);

      const result = verifier.verifyWebhook(payload, signatureHeader);
      expect(result.verified).toBe(true);
      expect(result.nonce).toBe(nonce);
      expect(result.timestamp).toBe(timestamp);
    });

    it("anti-replay: rejects duplicate webhook request with same nonce", () => {
      const payload = JSON.stringify({ event: "invoice_paid" });
      const { signatureHeader } = verifier.signPayload(payload);

      // First call succeeds
      const res1 = verifier.verifyWebhook(payload, signatureHeader);
      expect(res1.verified).toBe(true);

      // Replayed second call with identical nonce is rejected!
      expect(() => {
        verifier.verifyWebhook(payload, signatureHeader);
      }).toThrow(/Replay attack detected/);
    });

    it("anti-replay: rejects expired webhook timestamp exceeding tolerance", () => {
      const payload = JSON.stringify({ event: "user_signup" });
      const pastTimestamp = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago (tolerance is 60s)
      const { signatureHeader } = verifier.signPayload(payload, pastTimestamp);

      expect(() => {
        verifier.verifyWebhook(payload, signatureHeader);
      }).toThrow(/Webhook timestamp expired/);
    });

    it("rejects tampered webhook payload with invalid signature", () => {
      const payload = JSON.stringify({ event: "refund", amount: 10 });
      const { signatureHeader } = verifier.signPayload(payload);

      const tamperedPayload = JSON.stringify({ event: "refund", amount: 10000 }); // Modified amount!

      expect(() => {
        verifier.verifyWebhook(tamperedPayload, signatureHeader);
      }).toThrow(WebhookSecurityError);
    });
  });

  describe("Shared, Versioned, Exportable Workflows", () => {
    it("registers, exports, and imports workflow definitions cleanly", () => {
      const engine = new SharedWorkflowEngine();

      const workflow = engine.registerWorkflow({
        id: "wf-incident-alert",
        version: "1.0.0",
        name: "Incident Alerting Workflow",
        description: "Notifies team and creates linear ticket on incident",
        steps: [
          {
            id: "step-1",
            name: "Post to Slack Incident Channel",
            tool: "slack.post_message",
            input: { channelId: "incidents", text: "Incident detected!" },
            requiredPermissions: ["slack.write"],
            requiresConfirmation: true,
          },
          {
            id: "step-2",
            name: "Create Linear Tracking Issue",
            tool: "linear.create_issue",
            input: { teamKey: "ENG", title: "Investigate Incident" },
            requiredPermissions: ["linear.write"],
            requiresConfirmation: true,
          },
        ],
      });

      expect(workflow.id).toBe("wf-incident-alert");

      // Export
      const exportedJson = engine.exportWorkflow("wf-incident-alert");
      expect(exportedJson).toContain("Incident Alerting Workflow");

      // Preview execution
      const preview = engine.previewExecution("wf-incident-alert");
      expect(preview.stepsCount).toBe(2);
      expect(preview.allRequiredPermissions).toContain("slack.write");
      expect(preview.allRequiredPermissions).toContain("linear.write");
      expect(preview.confirmationSteps.length).toBe(2);
    });

    it("supports workflow version rollback", () => {
      const engine = new SharedWorkflowEngine();

      engine.registerWorkflow({
        id: "wf-sync",
        version: "1.0.0",
        name: "Sync Workflow",
        steps: [
          {
            id: "s1",
            name: "Read GDrive",
            tool: "gdrive.list_files",
            input: {},
            requiredPermissions: ["gdrive.read"],
            requiresConfirmation: false,
          },
        ],
      });

      engine.registerWorkflow({
        id: "wf-sync",
        version: "1.1.0",
        name: "Sync Workflow v1.1",
        steps: [
          {
            id: "s1",
            name: "Upload GDrive",
            tool: "gdrive.upload_file",
            input: {},
            requiredPermissions: ["gdrive.write"],
            requiresConfirmation: true,
          },
        ],
      });

      expect(engine.getWorkflow("wf-sync")?.version).toBe("1.1.0");

      const rolledBack = engine.rollbackWorkflow("wf-sync");
      expect(rolledBack.version).toBe("1.0.0");
      expect(engine.getWorkflow("wf-sync")?.version).toBe("1.0.0");
    });
  });
});

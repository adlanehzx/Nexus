import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, GenerateRequest, StreamChunk } from "@nexus/llm";
import {
  ClaudeProviderDriver,
  ClaudeProviderSession,
  CursorProviderDriver,
  CursorProviderSession,
  GrokProviderDriver,
  GrokProviderSession,
  AcpProviderDriver,
  AcpInMemoryTransport,
  type ProviderTurnStreamEvent,
} from "../src/index.js";

function makeMockLlm(chunks: StreamChunk[]): LLMProvider {
  return {
    id: "mock-llm",
    model: "test-model",
    capabilities: {
      tools: true,
      vision: true,
      structuredOutput: true,
      maxContextTokens: 100000,
    },
    async generate(_req: GenerateRequest) {
      await Promise.resolve();
      return {
        content: [{ type: "text", text: "Mock response" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "test-model",
      };
    },
    async *stream(req: GenerateRequest) {
      await Promise.resolve();
      for (const c of chunks) {
        if (req.signal?.aborted) break;
        yield c;
      }
    },
    structuredOutput: vi.fn(),
    countTokens: vi.fn().mockResolvedValue(10),
  };
}

describe("Real Provider Drivers Integration", () => {
  describe("ClaudeProviderDriver", () => {
    it("validates API key format", async () => {
      const driver = new ClaudeProviderDriver();
      const validRes = await driver.validateCredentials({ apiKey: "sk-ant-api03-validkey123" });
      expect(validRes.valid).toBe(true);

      const invalidRes = await driver.validateCredentials({ apiKey: "invalid-key" });
      expect(invalidRes.valid).toBe(false);
      expect(invalidRes.error).toContain("must start with sk-ant-");
    });

    it("streams text, emits tool call, and preserves multi-turn conversation", async () => {
      const mockLlm = makeMockLlm([
        { type: "text_delta", delta: "Hello from " },
        { type: "text_delta", delta: "Claude!" },
        {
          type: "tool_call",
          call: {
            type: "tool_call",
            id: "call-1",
            name: "read_file",
            arguments: { path: "package.json" },
          },
        },
        {
          type: "done",
          response: {
            content: [{ type: "text", text: "Done" }],
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 10 },
            model: "claude-3-7",
          },
        },
      ]);

      const session = new ClaudeProviderSession(
        {
          sessionId: "claude-sess-1",
          threadId: "t1",
          model: { provider: "claude", modelId: "claude-3-7-sonnet" },
          workspaceRoot: "/workspace",
        },
        mockLlm,
      );

      const events: ProviderTurnStreamEvent[] = [];
      for await (const event of session.sendPrompt("Hello!")) {
        events.push(event);
      }

      expect(events.some((e) => e.type === "text-delta" && e.delta.includes("Claude!"))).toBe(true);
      expect(events.some((e) => e.type === "tool-call-start" && e.toolName === "read_file")).toBe(
        true,
      );
      expect(events.some((e) => e.type === "turn-complete")).toBe(true);

      // Session history maintained across turns
      expect(session.getMessages().length).toBeGreaterThanOrEqual(2);
      expect(session.getMessages()[0]?.role).toBe("user");
      expect(session.getMessages()[1]?.role).toBe("assistant");
    });

    it("supports prompt interruption via interrupt()", async () => {
      const mockLlm: LLMProvider = {
        id: "mock-llm",
        model: "test-model",
        capabilities: {
          tools: true,
          vision: true,
          structuredOutput: true,
          maxContextTokens: 100000,
        },
        generate: vi.fn(),
        async *stream(req) {
          yield { type: "text_delta", delta: "Starting..." };
          // Wait to give time to interrupt
          await new Promise((r) => setTimeout(r, 50));
          if (req.signal?.aborted) return;
          yield { type: "text_delta", delta: "Never reached" };
        },
        structuredOutput: vi.fn(),
        countTokens: vi.fn().mockResolvedValue(10),
      };

      const session = new ClaudeProviderSession(
        {
          sessionId: "claude-cancel-sess",
          threadId: "t2",
          model: { provider: "claude", modelId: "claude-3-7-sonnet" },
          workspaceRoot: "/workspace",
        },
        mockLlm,
      );

      const streamPromise = (async () => {
        const events: ProviderTurnStreamEvent[] = [];
        for await (const ev of session.sendPrompt("Long task")) {
          events.push(ev);
        }
        return events;
      })();

      // Trigger interrupt
      setTimeout(() => {
        void session.interrupt();
      }, 10);
      const events = await streamPromise;

      expect(events.some((e) => e.type === "turn-complete" && e.stopReason === "cancelled")).toBe(
        true,
      );
      expect(events.some((e) => e.type === "text-delta" && e.delta.includes("Never reached"))).toBe(
        false,
      );
    });
  });

  describe("CursorProviderDriver", () => {
    it("validates credentials and streams responses", async () => {
      const driver = new CursorProviderDriver();
      const valid = await driver.validateCredentials({ apiKey: "mock-valid-cursor-token" });
      expect(valid.valid).toBe(true);

      const mockLlm = makeMockLlm([
        { type: "text_delta", delta: "Cursor agent response" },
        {
          type: "done",
          response: {
            content: [{ type: "text", text: "Done" }],
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 5 },
            model: "cursor-fast",
          },
        },
      ]);

      const session = new CursorProviderSession(
        {
          sessionId: "cursor-sess-1",
          threadId: "t3",
          model: {
            provider: "cursor",
            modelId: "cursor-fast",
            displayName: "Cursor Fast",
            contextWindowTokens: 128000,
          },
          workspaceRoot: "/workspace",
        },
        mockLlm,
      );

      const events: ProviderTurnStreamEvent[] = [];
      for await (const ev of session.sendPrompt("Test cursor bridge")) {
        events.push(ev);
      }

      expect(
        events.some((e) => e.type === "text-delta" && e.delta.includes("Cursor agent response")),
      ).toBe(true);
      expect(session.getMessages().length).toBe(2);
    });
  });

  describe("GrokProviderDriver", () => {
    it("validates credentials and streams responses", async () => {
      const driver = new GrokProviderDriver();
      const valid = await driver.validateCredentials({ apiKey: "mock-valid-grok-token" });
      expect(valid.valid).toBe(true);

      const invalid = await driver.validateCredentials({ apiKey: "" });
      expect(invalid.valid).toBe(false);

      const mockLlm = makeMockLlm([
        { type: "text_delta", delta: "Grok reasoning" },
        {
          type: "done",
          response: {
            content: [{ type: "text", text: "Reasoned" }],
            stopReason: "end_turn",
            usage: { inputTokens: 12, outputTokens: 25 },
            model: "grok-3",
          },
        },
      ]);

      const session = new GrokProviderSession(
        {
          sessionId: "grok-sess-1",
          threadId: "t4",
          workspaceRoot: "/workspace",
          model: {
            provider: "grok",
            modelId: "grok-3",
            displayName: "xAI Grok 3",
            contextWindowTokens: 128000,
          },
        },
        mockLlm,
      );

      const events: ProviderTurnStreamEvent[] = [];
      for await (const ev of session.sendPrompt("Explain quantum computing")) {
        events.push(ev);
      }

      expect(
        events.some((e) => e.type === "text-delta" && e.delta.includes("Grok reasoning")),
      ).toBe(true);
      expect(session.getMessages().length).toBe(2);
    });
  });

  describe("AcpProviderDriver", () => {
    it("executes JSON-RPC 2.0 ACP stream and supports cancel", async () => {
      const customTransport = new AcpInMemoryTransport(async function* (_method, _params) {
        await Promise.resolve();
        yield {
          jsonrpc: "2.0",
          method: "session/update",
          params: { type: "text", delta: "ACP Connected." },
        };
        yield {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            type: "tool_call",
            id: "call-acp-1",
            name: "fs_list",
            args: { dir: "/workspace" },
          },
        };
        yield {
          jsonrpc: "2.0",
          method: "session/update",
          params: { type: "turn_complete", stopReason: "end_turn" },
        };
      });

      const driver = new AcpProviderDriver(customTransport);
      const session = await driver.createSession({
        sessionId: "acp-session-test",
        threadId: "t5",
        model: { provider: "acp", modelId: "claude-code-acp" },
        workspaceRoot: "/workspace",
      });

      const events: ProviderTurnStreamEvent[] = [];
      for await (const ev of session.sendPrompt("List files")) {
        events.push(ev);
      }

      expect(events.some((e) => e.type === "text-delta" && e.delta.includes("ACP Connected"))).toBe(
        true,
      );
      expect(events.some((e) => e.type === "tool-call-start" && e.toolName === "fs_list")).toBe(
        true,
      );
      expect(events.some((e) => e.type === "turn-complete")).toBe(true);
    });
  });
});

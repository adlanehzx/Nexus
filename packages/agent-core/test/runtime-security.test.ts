import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import {
  SymlinkAwarePathChecker,
  ToolSecurityPolicyEvaluator,
  UnifiedAgentRuntime,
  type ProviderSession,
  type ProviderTurnStreamEvent,
} from "../src/index.js";

describe("Runtime Security & Containment", () => {
  const tmpDir = os.tmpdir();

  it("permits paths strictly inside the workspace root", () => {
    const insidePath = path.join(tmpDir, "project", "src", "index.ts");
    const workspaceRoot = path.join(tmpDir, "project");

    expect(SymlinkAwarePathChecker.isContained(insidePath, workspaceRoot)).toBe(true);
    expect(SymlinkAwarePathChecker.isContained(workspaceRoot, workspaceRoot)).toBe(true);
  });

  it("blocks directory traversal and external paths", () => {
    const workspaceRoot = path.join(tmpDir, "safe-project");
    const escapePath = path.join(tmpDir, "safe-project", "..", "escape.txt");
    const etcPasswd = "/etc/passwd";

    expect(SymlinkAwarePathChecker.isContained(escapePath, workspaceRoot)).toBe(false);
    expect(SymlinkAwarePathChecker.isContained(etcPasswd, workspaceRoot)).toBe(false);
  });

  it("strictly denies access to system-critical paths like /etc", () => {
    const workspaceRoot = path.join(tmpDir, "safe-project");
    const evaluator = new ToolSecurityPolicyEvaluator(workspaceRoot, "LOW");

    const evaluation = evaluator.evaluateToolCall("write_file", { path: "/etc/hosts" }, "MEDIUM");

    expect(evaluation.disposition).toBe("deny");
    expect(evaluation.reason).toContain("strictly prohibited");
  });

  it("strictly denies execution of destructive shell patterns", () => {
    const workspaceRoot = path.join(tmpDir, "safe-project");
    const evaluator = new ToolSecurityPolicyEvaluator(workspaceRoot, "LOW");

    const evaluation = evaluator.evaluateToolCall(
      "run_command",
      { commandLine: "rm -rf /" },
      "CRITICAL",
    );

    expect(evaluation.disposition).toBe("deny");
    expect(evaluation.reason).toContain("strictly forbidden");
  });

  it("asks confirmation for non-system external paths", () => {
    const workspaceRoot = path.join(tmpDir, "safe-project");
    const evaluator = new ToolSecurityPolicyEvaluator(workspaceRoot, "LOW");

    const evaluation = evaluator.evaluateToolCall(
      "read_file",
      { path: path.join(tmpDir, "other-external-project", "file.txt") },
      "MEDIUM",
    );

    expect(evaluation.disposition).toBe("ask");
    expect(evaluation.confirmationRequest?.targetPath).toBeDefined();
  });

  it("asks confirmation for shell execution and approves securely", async () => {
    const mockSession: ProviderSession = {
      id: "mock-session-1",
      providerType: "acp",
      modelId: "mock-model",
      async *sendPrompt(): AsyncIterable<ProviderTurnStreamEvent> {
        await Promise.resolve();
        yield { type: "text-delta", delta: "Processing" };
        yield {
          type: "tool-call-start",
          callId: "call-1",
          toolName: "run_command",
          args: { commandLine: "npm test", token: "secret_token_12345" },
        };
        yield { type: "turn-complete", stopReason: "end_turn" };
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    };

    const auditLogs: Record<string, unknown>[] = [];
    const confirmationHandler = vi.fn().mockResolvedValue(true);
    const mockExecutor = vi.fn().mockResolvedValue({ stdout: "Tests passed" });

    const runtime = new UnifiedAgentRuntime(mockSession, {
      workspaceRoot: tmpDir,
      autoApproveMaxRisk: "LOW",
      onConfirmationRequired: confirmationHandler,
      onAuditLog: (entry) => auditLogs.push(entry),
      toolExecutor: mockExecutor,
    });

    const receivedEvents: ProviderTurnStreamEvent[] = [];
    for await (const event of runtime.executeTurn("Run tests")) {
      receivedEvents.push(event);
    }

    expect(confirmationHandler).toHaveBeenCalledTimes(1);
    expect(mockExecutor).toHaveBeenCalledWith("run_command", {
      commandLine: "npm test",
      token: "secret_token_12345",
    });
    expect(auditLogs.length).toBe(1);
    expect(receivedEvents.some((e) => e.type === "tool-call-complete")).toBe(true);
  });

  it("blocks execution BEFORE effect if user rejects confirmation", async () => {
    const mockSession: ProviderSession = {
      id: "mock-session-2",
      providerType: "claude",
      modelId: "claude-3-5-sonnet",
      async *sendPrompt(): AsyncIterable<ProviderTurnStreamEvent> {
        await Promise.resolve();
        yield {
          type: "tool-call-start",
          callId: "call-blocked",
          toolName: "run_command",
          args: { commandLine: "git push origin master --force" },
        };
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    };

    const confirmationHandler = vi.fn().mockResolvedValue(false); // User rejects!
    const mockExecutor = vi.fn();

    const runtime = new UnifiedAgentRuntime(mockSession, {
      workspaceRoot: tmpDir,
      autoApproveMaxRisk: "LOW",
      onConfirmationRequired: confirmationHandler,
      toolExecutor: mockExecutor,
    });

    const events: ProviderTurnStreamEvent[] = [];
    for await (const event of runtime.executeTurn("Force push")) {
      events.push(event);
    }

    expect(confirmationHandler).toHaveBeenCalledTimes(1);
    // CRITICAL: The executor was NEVER called!
    expect(mockExecutor).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "error" && e.message.includes("cancelled by user"))).toBe(
      true,
    );
  });
});

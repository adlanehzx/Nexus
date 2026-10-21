import { describe, expect, it } from "vitest";
import {
  badOutputTool,
  brokenTool,
  calendarListTool,
  callTurn,
  dangerousTool,
  fileWriteTool,
  hangingTool,
  makeEmailTool,
  makeFlakyTool,
  makeHarness,
  weatherTool,
} from "./fixtures.js";
import type { ToolDefinition } from "@nexus/tools";

const asTools = (...tools: unknown[]): ToolDefinition<never, unknown>[] =>
  tools as ToolDefinition<never, unknown>[];

describe("simple response", () => {
  it("answers without calling any tool", async () => {
    const h = makeHarness({ turns: [{ kind: "final", text: "Hello Alex." }] });

    const { record } = await h.run("Hi");

    expect(record.status).toBe("completed");
    expect(record.stopReason).toBe("final_answer");
    expect(record.response).toBe("Hello Alex.");
    expect(record.iterations).toBe(1);
    expect(record.toolsUsed).toHaveLength(0);
    expect(record.usage.inputTokens).toBeGreaterThan(0);
  });

  it("traces the run end-to-end", async () => {
    const h = makeHarness({ turns: [{ kind: "final", text: "ok" }] });
    const { record } = await h.run();

    expect(record.runId).toBeTruthy();
    expect(record.userId).toBe("user-1");
    expect(record.conversationId).toBe("conv-1");
    expect(record.startTime).toBeTruthy();
    expect(record.endTime).toBeTruthy();
    expect(record.errors).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toEqual([
      "run.started",
      "iteration.started",
      "llm.completed",
      "agent.message",
      "run.finished",
    ]);
  });

  it("preserves the selected model and router fallbacks", async () => {
    const h = makeHarness({
      turns: [{ kind: "final", text: "ok", fallbackCount: 2 }],
    });

    const { record } = await h.run();

    expect(record.model).toBe("scripted-model");
    expect(record.fallbackCount).toBe(2);
  });
});

describe("tool calling", () => {
  it("executes the tool and feeds its result back to the model", async () => {
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { city: "Paris" }),
        { kind: "final", text: "It is 21 °C in Paris." },
      ],
    });

    const { record } = await h.run("What is the weather in Paris?");

    expect(record.status).toBe("completed");
    expect(record.iterations).toBe(2);
    expect(record.toolsUsed).toHaveLength(1);
    expect(record.toolsUsed[0]).toMatchObject({ name: "weather.get", status: "success" });

    // The second call to the model must contain the tool observation: this
    // is what distinguishes a real agent loop from a single one-shot call.
    const secondRequest = h.llm.requests[1];
    const toolResult = secondRequest?.messages.at(-1);
    expect(toolResult?.role).toBe("tool");
    expect(JSON.stringify(toolResult?.content)).toContain("21");
  });

  it("exposes only authorized tools to the model", async () => {
    const h = makeHarness({
      turns: [{ kind: "final", text: "ok" }],
      tools: asTools(weatherTool, calendarListTool),
      permissions: [], // calendar.read not granted
    });

    await h.run();

    const exposed = h.llm.requests[0]?.tools?.map((t) => t.name);
    expect(exposed).toEqual(["weather.get"]);
  });

  it("describes tools via JSON Schema derived from Zod", async () => {
    const h = makeHarness({ turns: [{ kind: "final", text: "ok" }] });
    await h.run();

    expect(h.llm.requests[0]?.tools?.[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });
});

describe("multiple tool calls", () => {
  it("executes multiple calls in a single turn in order", async () => {
    const h = makeHarness({
      turns: [
        {
          kind: "tool_calls",
          calls: [
            { id: "c1", name: "weather.get", arguments: { city: "Paris" } },
            { id: "c2", name: "calendar.list", arguments: { day: "2026-09-02" } },
          ],
        },
        { kind: "final", text: "Here you go." },
      ],
      tools: asTools(weatherTool, calendarListTool),
      permissions: ["calendar.read"],
    });

    const { record } = await h.run();

    expect(record.status).toBe("completed");
    expect(record.toolsUsed.map((t) => t.name)).toEqual(["weather.get", "calendar.list"]);
    expect(record.toolsUsed.every((t) => t.status === "success")).toBe(true);
  });

  it("chains calls across multiple iterations", async () => {
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { city: "Paris" }, "c1"),
        callTurn("calendar.list", { day: "tomorrow" }, "c2"),
        { kind: "final", text: "Done." },
      ],
      tools: asTools(weatherTool, calendarListTool),
      permissions: ["calendar.read"],
    });

    const { record } = await h.run();

    expect(record.iterations).toBe(3);
    expect(record.toolsUsed).toHaveLength(2);
  });
});

describe("tool failure", () => {
  it("transforms failure into observation and lets agent conclude", async () => {
    const h = makeHarness({
      turns: [
        callTurn("broken.tool", {}),
        { kind: "final", text: "Could not proceed: disk full." },
      ],
      tools: asTools(brokenTool),
    });

    const { record } = await h.run();

    // A tool failure is not a run failure: the agent should be able
    // to explain it rather than crashing.
    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]).toMatchObject({ name: "broken.tool", status: "failed" });
    expect(record.errors).toHaveLength(1);
    expect(JSON.stringify(h.llm.requests[1]?.messages.at(-1))).toContain("broken.tool");
  });

  it("rejects output not matching tool schema", async () => {
    const h = makeHarness({
      turns: [callTurn("bad.output", {}), { kind: "final", text: "Invalid output." }],
      tools: asTools(badOutputTool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]?.status).toBe("failed");
    expect(record.errors[0]?.code).toBe("TOOL_OUTPUT_INVALID");
  });

  it("stops after too many consecutive failures", async () => {
    const h = makeHarness({
      turns: [
        callTurn("broken.tool", {}, "c1"),
        callTurn("broken.tool", {}, "c2"),
        callTurn("broken.tool", {}, "c3"),
        callTurn("broken.tool", {}, "c4"),
        { kind: "final", text: "never reached" },
      ],
      tools: asTools(brokenTool),
      policy: { maxConsecutiveToolFailures: 2, maxIdenticalToolCalls: 99 },
    });

    const { record } = await h.run();

    expect(record.status).toBe("incomplete");
    expect(record.stopReason).toBe("tool_failure_limit");
    expect(record.response).toContain("Failed");
  });
});

describe("error recovery", () => {
  it("retries transient failure with exponential backoff", async () => {
    const flaky = makeFlakyTool(2);
    const h = makeHarness({
      turns: [callTurn("flaky.fetch", { url: "https://x" }), { kind: "final", text: "200." }],
      tools: asTools(flaky.tool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]).toMatchObject({ status: "success", attempts: 3 });
    expect(flaky.attempts()).toBe(3);
    // 100 then 200: exponential growth without jitter in tests.
    expect(h.sleeps).toEqual([100, 200]);
  });

  it("never retries a permanent failure", async () => {
    const h = makeHarness({
      turns: [callTurn("broken.tool", {}), { kind: "final", text: "ok" }],
      tools: asTools(brokenTool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]?.attempts).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("gives up after exhausting attempts", async () => {
    const flaky = makeFlakyTool(99);
    const h = makeHarness({
      turns: [callTurn("flaky.fetch", { url: "https://x" }), { kind: "final", text: "ko" }],
      tools: asTools(flaky.tool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(flaky.attempts()).toBe(3);
  });
});

describe("timeouts", () => {
  it("interrupts a tool that ignores its abort signal", async () => {
    const h = makeHarness({
      turns: [callTurn("slow.task", {}), { kind: "final", text: "too slow" }],
      tools: asTools(hangingTool),
    });

    const { record } = await h.run();

    expect(record.toolsUsed[0]?.status).toBe("failed");
    expect(record.errors[0]?.code).toBe("TOOL_TIMEOUT");
  });

  it("stops the run when global timeout is exceeded", async () => {
    let clock = 1_000_000;
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { city: "Paris" }, "c1"),
        callTurn("weather.get", { city: "Lyon" }, "c2"),
        { kind: "final", text: "never reached" },
      ],
      policy: { globalTimeoutMs: 5_000 },
      now: () => {
        clock += 3_000; // clock advances 3s each call
        return clock;
      },
    });

    const { record } = await h.run();

    expect(record.status).toBe("incomplete");
    expect(record.stopReason).toBe("global_timeout");
    expect(record.response).toContain("allocated time elapsed");
  });
});

describe("cancellation", () => {
  it("cancels a run while the model is reasoning", async () => {
    const h = makeHarness({ turns: [{ kind: "hang" }] });

    const running = h.orchestrator.run({
      userId: "user-1",
      conversationId: "conv-1",
      message: "Long running task",
    });

    // Run ID is published by run.started before run() returns.
    await new Promise((resolve) => setImmediate(resolve));
    const started = h.events.find((e) => e.type === "run.started");
    expect(started).toBeDefined();
    const runId = started?.type === "run.started" ? started.runId : "";
    expect(await h.store.load(runId)).toBeDefined();

    await h.orchestrator.cancel(runId);

    const { record } = await running;

    expect(record.status).toBe("cancelled");
    expect(record.stopReason).toBe("cancelled");
    expect(record.toolsUsed).toHaveLength(0);
  });

  it("cancels a run suspended waiting for confirmation", async () => {
    const email = makeEmailTool();
    const h = makeHarness({
      turns: [callTurn("email.send", { to: "a@b.c", subject: "s", body: "b" })],
      tools: asTools(email.tool),
      permissions: ["email.send"],
    });

    const { record } = await h.run();
    expect(record.status).toBe("waiting_for_confirmation");

    const cancelled = await h.orchestrator.cancel(record.runId);
    expect(cancelled).toBe(true);

    const after = await h.orchestrator.getRun(record.runId);
    expect(after?.status).toBe("cancelled");
    expect(email.sent).toHaveLength(0);
  });
});

describe("permissions", () => {
  it("denies a tool whose permission is not granted", async () => {
    const h = makeHarness({
      turns: [
        callTurn("calendar.list", { day: "tomorrow" }),
        { kind: "final", text: "I do not have access to your calendar." },
      ],
      tools: asTools(calendarListTool),
      permissions: [],
    });

    const { record } = await h.run();

    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]).toMatchObject({ status: "denied", errorCode: "PERMISSION_DENIED" });
    expect(JSON.stringify(h.llm.requests[1]?.messages.at(-1))).toContain("Action denied");
  });

  it("allows a tool whose permission is granted", async () => {
    const h = makeHarness({
      turns: [
        callTurn("calendar.list", { day: "tomorrow" }),
        { kind: "final", text: "1 event." },
      ],
      tools: asTools(calendarListTool),
      permissions: ["calendar.read"],
    });

    const { record } = await h.run();
    expect(record.toolsUsed[0]?.status).toBe("success");
  });

  it("accepts a domain wildcard", async () => {
    const h = makeHarness({
      turns: [callTurn("calendar.list", { day: "tomorrow" }), { kind: "final", text: "ok" }],
      tools: asTools(calendarListTool),
      permissions: ["calendar.*"],
    });

    const { record } = await h.run();
    expect(record.toolsUsed[0]?.status).toBe("success");
  });
});

describe("confirmation", () => {
  it("suspends the run and exposes the request", async () => {
    const email = makeEmailTool();
    const h = makeHarness({
      turns: [callTurn("email.send", { to: "recruteur@x.com", subject: "Re", body: "Hello" })],
      tools: asTools(email.tool),
      permissions: ["email.send"],
    });

    const { record, confirmation } = await h.run();

    expect(record.status).toBe("waiting_for_confirmation");
    expect(record.endTime).toBeNull();
    expect(email.sent).toHaveLength(0);

    expect(confirmation).toBeDefined();
    expect(confirmation?.tool).toBe("email.send");
    expect(confirmation?.riskLevel).toBe("HIGH");
    expect(confirmation?.action).toBe("Send an email to recruteur@x.com");
    // Preview shows exact content, not an LLM hallucination.
    expect(confirmation?.description).toContain("recruteur@x.com");
    expect(confirmation?.expiresAt.getTime()).toBeGreaterThan(confirmation!.createdAt.getTime());
  });

  it("executes the action after approval", async () => {
    const email = makeEmailTool();
    const h = makeHarness({
      turns: [
        callTurn("email.send", { to: "a@b.c", subject: "Subject", body: "Body" }),
        { kind: "final", text: "Email sent." },
      ],
      tools: asTools(email.tool),
      permissions: ["email.send"],
    });

    const first = await h.run();
    const resumed = await h.orchestrator.resume(first.record.runId, "approved");

    expect(resumed.record.status).toBe("completed");
    expect(resumed.record.response).toBe("Email sent.");
    expect(email.sent).toEqual([{ to: "a@b.c", subject: "Subject", body: "Body" }]);
    expect(resumed.record.toolsUsed.at(-1)).toMatchObject({
      name: "email.send",
      status: "success",
    });
  });

  it("executes nothing after rejection", async () => {
    const email = makeEmailTool();
    const h = makeHarness({
      turns: [
        callTurn("email.send", { to: "a@b.c", subject: "s", body: "b" }),
        { kind: "final", text: "Understood, sending nothing." },
      ],
      tools: asTools(email.tool),
      permissions: ["email.send"],
    });

    const first = await h.run();
    const resumed = await h.orchestrator.resume(first.record.runId, "rejected");

    expect(resumed.record.status).toBe("completed");
    expect(email.sent).toHaveLength(0);
    expect(resumed.record.toolsUsed.at(-1)?.status).toBe("rejected");
    // Rejection is reinjected: agent acknowledges it.
    expect(JSON.stringify(h.llm.requests.at(-1)?.messages.at(-1))).toContain("rejected");
  });

  it("enforces confirmation on CRITICAL action even if tool does not request it", async () => {
    const h = makeHarness({
      turns: [callTurn("terminal.execute", { command: "rm -rf /" })],
      tools: asTools(dangerousTool),
      permissions: ["terminal.execute"],
    });

    const { record, confirmation } = await h.run();

    expect(record.status).toBe("waiting_for_confirmation");
    expect(confirmation?.riskLevel).toBe("CRITICAL");
  });

  it("makes confirmation dependent on arguments", async () => {
    const h = makeHarness({
      turns: [
        callTurn("filesystem.write", { path: "/workspace/project/x.ts", content: "ok" }),
        { kind: "final", text: "Written." },
      ],
      tools: asTools(fileWriteTool),
      permissions: ["filesystem.write"],
      autoApproveMaxRisk: "MEDIUM",
    });

    const { record } = await h.run();

    // Inside workspace: no confirmation.
    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]?.status).toBe("success");
  });

  it("requests confirmation outside the workspace", async () => {
    const h = makeHarness({
      turns: [callTurn("filesystem.write", { path: "/etc/hosts", content: "x" })],
      tools: asTools(fileWriteTool),
      permissions: ["filesystem.write"],
      autoApproveMaxRisk: "MEDIUM",
    });

    const { record } = await h.run();
    expect(record.status).toBe("waiting_for_confirmation");
  });

  it("refuses to resume a run that is not waiting for confirmation", async () => {
    const h = makeHarness({ turns: [{ kind: "final", text: "ok" }] });
    const { record } = await h.run();

    await expect(h.orchestrator.resume(record.runId, "approved")).rejects.toThrow(
      /is not waiting for confirmation/,
    );
  });
});

describe("budgets", () => {
  it("stops at maximum iterations with a partial summary", async () => {
    const h = makeHarness({
      turns: Array.from({ length: 10 }, (_, i) =>
        callTurn("weather.get", { city: `city-${String(i)}` }, `c${String(i)}`),
      ),
      policy: { maxIterations: 3 },
    });

    const { record } = await h.run();

    expect(record.status).toBe("incomplete");
    expect(record.stopReason).toBe("max_iterations");
    expect(record.iterations).toBe(3);
    // An agent that stops silently is a defect.
    expect(record.response).toContain("Completed");
    expect(record.response).toContain("weather.get");
  });

  it("stops at maximum tool calls", async () => {
    const h = makeHarness({
      turns: Array.from({ length: 10 }, (_, i) =>
        callTurn("weather.get", { city: `v${String(i)}` }, `c${String(i)}`),
      ),
      policy: { maxToolCalls: 2, maxIterations: 20 },
    });

    const { record } = await h.run();

    expect(record.stopReason).toBe("max_tool_calls");
    expect(record.toolsUsed.filter((t) => t.status === "success")).toHaveLength(2);
  });

  it("blocks a tool called indefinitely with identical arguments", async () => {
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { city: "Paris" }, "c1"),
        callTurn("weather.get", { city: "Paris" }, "c2"),
        callTurn("weather.get", { city: "Paris" }, "c3"),
        { kind: "final", text: "Stopping." },
      ],
      policy: { maxIdenticalToolCalls: 2 },
    });

    const { record } = await h.run();

    expect(record.toolsUsed.map((t) => t.status)).toEqual(["success", "success", "skipped"]);
    expect(record.errors.at(-1)?.code).toBe("TOOL_LOOP_DETECTED");
  });
});

describe("malformed arguments", () => {
  it("returns validation errors to the model without executing the tool", async () => {
    const h = makeHarness({
      turns: [
        callTurn("weather.get", { ville: "Paris" }), // wrong key
        callTurn("weather.get", { city: "Paris" }, "c2"),
        { kind: "final", text: "21 °C." },
      ],
    });

    const { record } = await h.run();

    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]).toMatchObject({
      status: "failed",
      errorCode: "TOOL_INPUT_INVALID",
      attempts: 0,
    });
    expect(record.toolsUsed[1]?.status).toBe("success");

    const observation = JSON.stringify(h.llm.requests[1]?.messages.at(-1));
    expect(observation).toContain("Invalid arguments");
    expect(observation).toContain("city");
  });

  it("treats unknown tool name as an observation", async () => {
    const h = makeHarness({
      turns: [
        callTurn("imaginary.tool", { x: 1 }),
        { kind: "final", text: "This tool does not exist." },
      ],
    });

    const { record } = await h.run();

    expect(record.status).toBe("completed");
    expect(record.toolsUsed[0]?.errorCode).toBe("TOOL_NOT_FOUND");
    expect(JSON.stringify(h.llm.requests[1]?.messages.at(-1))).toContain("weather.get");
  });
});

describe("provider failure", () => {
  it("fails cleanly without leaving the run running", async () => {
    const h = makeHarness({
      turns: [{ kind: "error", error: new Error("503 upstream") }],
    });

    const { record } = await h.run();

    expect(record.status).toBe("failed");
    expect(record.stopReason).toBe("provider_error");
    expect(record.endTime).toBeTruthy();
    expect(record.errors).toHaveLength(1);
    expect(record.response).toContain("generation service");
  });

  it("fails cleanly when model is called more times than expected", async () => {
    // Script exhausted: scripted provider throws, loop catches it.
    const h = makeHarness({ turns: [callTurn("weather.get", { city: "Paris" })] });

    const { record } = await h.run();

    expect(record.status).toBe("failed");
    expect(record.toolsUsed[0]?.status).toBe("success");
  });
});

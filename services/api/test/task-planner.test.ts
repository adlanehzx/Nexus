import { describe, test, expect } from "vitest";
import { ScriptedLLMProvider } from "@nexus/llm/testing";
import { TaskPlanner, TaskPlannerError } from "../src/services/task-planner.js";

const DEFAULT_CAPS = [
  "terminal.execute",
  "browser.navigate",
  "filesystem.read",
  "android.ui.click",
];

describe("TaskPlanner", () => {
  test("Generates valid plan for simple instruction (1 step, safe risk)", async () => {
    const llm = new ScriptedLLMProvider([
      {
        kind: "final",
        text: JSON.stringify({
          title: "Read file",
          steps: [
            {
              id: "step-1",
              description: "File reading",
              requiredCapabilities: ["filesystem.read"],
              tool: "device.filesystem.read",
              arguments: { path: "/tmp/test.txt" },
              dependsOn: [],
              riskLevel: "SAFE",
            },
          ],
          reasoning: "Local read, low risk",
        }),
      },
    ]);

    const planner = new TaskPlanner({ llm, availableCapabilities: DEFAULT_CAPS });

    const { planInput } = await planner.plan({
      instruction: "Read file /tmp/test.txt",
      userId: "user-1",
      originClientDeviceId: "device-1",
      correlationId: "corr-1",
    });

    expect(planInput.title).toBe("Read file");
    expect(planInput.steps).toHaveLength(1);
    expect(planInput.steps[0]!.tool).toBe("device.filesystem.read");
    expect(planInput.steps[0]!.requiredCapabilities).toEqual(["filesystem.read"]);
    expect(planInput.steps[0]!.riskLevel).toBe("SAFE");
  });

  test("Generates plan with multiple steps and dependencies", async () => {
    const llm = new ScriptedLLMProvider([
      {
        kind: "final",
        text: JSON.stringify({
          title: "Open YouTube on PC",
          steps: [
            {
              id: "step-1",
              description: "Open Chrome",
              requiredCapabilities: ["terminal.execute"],
              tool: "device.terminal.execute",
              arguments: { command: "start chrome" },
              dependsOn: [],
              riskLevel: "HIGH",
            },
            {
              id: "step-2",
              description: "Navigate to YouTube",
              requiredCapabilities: ["browser.navigate"],
              tool: "device.browser.navigate",
              arguments: { url: "https://youtube.com" },
              dependsOn: ["step-1"],
              riskLevel: "LOW",
            },
          ],
          reasoning: "First open chrome, then navigate",
        }),
      },
    ]);

    const planner = new TaskPlanner({ llm, availableCapabilities: DEFAULT_CAPS });

    const { planInput } = await planner.plan({
      instruction: "Open Chrome on my PC and navigate to YouTube.",
      userId: "user-1",
      originClientDeviceId: "device-1",
      correlationId: "corr-1",
    });

    expect(planInput.steps).toHaveLength(2);
    expect(planInput.steps[1]!.dependsOn).toEqual(["step-1"]);
    expect(planInput.steps[0]!.riskLevel).toBe("HIGH"); // Explicit check of riskLevel
    expect(planInput.steps[1]!.riskLevel).toBe("LOW");
  });

  test("Fails if instruction is ambiguous or impossible (empty plan)", async () => {
    const llm = new ScriptedLLMProvider([
      {
        kind: "final",
        text: JSON.stringify({
          title: "Impossible task",
          steps: [],
          reasoning: "No capability to brew coffee.",
        }),
      },
    ]);

    const planner = new TaskPlanner({ llm, availableCapabilities: DEFAULT_CAPS });

    await expect(
      planner.plan({
        instruction: "Brew me a coffee",
        userId: "user-1",
        originClientDeviceId: "device-1",
        correlationId: "corr-1",
      }),
    ).rejects.toThrowError(TaskPlannerError);
  });

  test("Fails if LLM output does not match structured output schema", async () => {
    const llm = new ScriptedLLMProvider([
      {
        kind: "final",
        text: JSON.stringify({
          title: "Malformed task",
          steps: [
            {
              // missing 'id', 'tool' and others, so it will fail schema validation
              description: "Bad step",
            },
          ],
          reasoning: "...",
        }),
      },
    ]);

    const planner = new TaskPlanner({ llm, availableCapabilities: DEFAULT_CAPS });

    await expect(
      planner.plan({
        instruction: "Do something",
        userId: "user-1",
        originClientDeviceId: "device-1",
        correlationId: "corr-1",
      }),
    ).rejects.toThrowError(TaskPlannerError);
  });
});

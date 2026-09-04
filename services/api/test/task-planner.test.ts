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
  test("Génère un plan valide pour une instruction simple (1 étape, safe risk)", async () => {
    const llm = new ScriptedLLMProvider([
      {
        kind: "final",
        text: JSON.stringify({
          title: "Lire le fichier",
          steps: [
            {
              id: "step-1",
              description: "Lecture du fichier",
              requiredCapabilities: ["filesystem.read"],
              tool: "device.filesystem.read",
              arguments: { path: "/tmp/test.txt" },
              dependsOn: [],
              riskLevel: "SAFE",
            },
          ],
          reasoning: "Lecture locale, risque faible",
        }),
      },
    ]);

    const planner = new TaskPlanner({ llm, availableCapabilities: DEFAULT_CAPS });

    const { planInput } = await planner.plan({
      instruction: "Lis le fichier /tmp/test.txt",
      userId: "user-1",
      originClientDeviceId: "device-1",
      correlationId: "corr-1",
    });

    expect(planInput.title).toBe("Lire le fichier");
    expect(planInput.steps).toHaveLength(1);
    expect(planInput.steps[0]!.tool).toBe("device.filesystem.read");
    expect(planInput.steps[0]!.requiredCapabilities).toEqual(["filesystem.read"]);
    expect(planInput.steps[0]!.riskLevel).toBe("SAFE");
  });

  test("Génère un plan avec plusieurs étapes et des dépendances", async () => {
    const llm = new ScriptedLLMProvider([
      {
        kind: "final",
        text: JSON.stringify({
          title: "Ouvrir youtube sur PC",
          steps: [
            {
              id: "step-1",
              description: "Ouvrir Chrome",
              requiredCapabilities: ["terminal.execute"],
              tool: "device.terminal.execute",
              arguments: { command: "start chrome" },
              dependsOn: [],
              riskLevel: "HIGH",
            },
            {
              id: "step-2",
              description: "Aller sur Youtube",
              requiredCapabilities: ["browser.navigate"],
              tool: "device.browser.navigate",
              arguments: { url: "https://youtube.com" },
              dependsOn: ["step-1"],
              riskLevel: "LOW",
            },
          ],
          reasoning: "D'abord on ouvre chrome, ensuite on navigue",
        }),
      },
    ]);

    const planner = new TaskPlanner({ llm, availableCapabilities: DEFAULT_CAPS });

    const { planInput } = await planner.plan({
      instruction: "Ouvre Chrome sur mon PC et va sur YouTube.",
      userId: "user-1",
      originClientDeviceId: "device-1",
      correlationId: "corr-1",
    });

    expect(planInput.steps).toHaveLength(2);
    expect(planInput.steps[1]!.dependsOn).toEqual(["step-1"]);
    expect(planInput.steps[0]!.riskLevel).toBe("HIGH"); // Explicit check of riskLevel
    expect(planInput.steps[1]!.riskLevel).toBe("LOW");
  });

  test("Échoue si la demande est ambiguë ou impossible (plan vide)", async () => {
    const llm = new ScriptedLLMProvider([
      {
        kind: "final",
        text: JSON.stringify({
          title: "Tâche impossible",
          steps: [],
          reasoning: "Il n'y a pas de capacité pour préparer un café.",
        }),
      },
    ]);

    const planner = new TaskPlanner({ llm, availableCapabilities: DEFAULT_CAPS });

    await expect(
      planner.plan({
        instruction: "Prépare moi un café",
        userId: "user-1",
        originClientDeviceId: "device-1",
        correlationId: "corr-1",
      }),
    ).rejects.toThrowError(TaskPlannerError);
  });

  test("Échoue si le format LLM ne respecte pas le schéma de sortie structurée", async () => {
    const llm = new ScriptedLLMProvider([
      {
        kind: "final",
        text: JSON.stringify({
          title: "Tâche mal formatée",
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
        instruction: "Fais un truc",
        userId: "user-1",
        originClientDeviceId: "device-1",
        correlationId: "corr-1",
      }),
    ).rejects.toThrowError(TaskPlannerError);
  });
});

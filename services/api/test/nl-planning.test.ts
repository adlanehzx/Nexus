import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeApi, createAccount, registerDevice, type ApiHarness } from "./harness.js";
// A mock LLM provider just for the integration test.
// We return a hardcoded JSON task plan.
const fakeLlm = {
  id: "fake",
  model: "fake",
  capabilities: { tools: false, vision: false, structuredOutput: true, maxContextTokens: 100000 },
  countTokens() {
    return Promise.resolve(10);
  },
  structuredOutput<T>(_request: unknown, _schema: unknown): Promise<T> {
    return Promise.resolve({
      title: "Open Chrome",
      reasoning: "User request",
      steps: [
        {
          id: "step-1",
          description: "Opens Chrome",
          requiredCapabilities: ["app.open"],
          tool: "device.app.open",
          arguments: { app: "chrome" },
          dependsOn: [],
          riskLevel: "LOW",
        },
      ],
    } as unknown as T);
  },
  generate() {
    return Promise.resolve({
      content: [],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "fake",
    });
  },
  async *stream() {
    await Promise.resolve();
    yield { type: "text_delta", delta: "" } as unknown as { type: "text_delta"; delta: string };
  },
};

describe("POST /api/v1/tasks/instruct", () => {
  let harness: ApiHarness;

  beforeEach(async () => {
    harness = await makeApi({ llmProvider: fakeLlm });
  });

  afterEach(async () => {
    await harness.close();
  });

  it("generates a plan and executes it from natural language", async () => {
    const account = await createAccount(harness, "test@nexus.fr");
    const { device } = await registerDevice(harness, account, {
      name: "PC",
      role: "CLIENT",
      permissions: ["app.open"],
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks/instruct",
      headers: account.authorization,
      payload: {
        instruction: "open Chrome on my Windows PC",
        originClientDeviceId: device.id,
      },
    });

    expect(response.statusCode).toBe(202);

    const body = response.json<{ data: { title: string; steps: unknown[] } }>();
    expect(body.data.title).toBe("Open Chrome");
    expect(body.data.steps).toHaveLength(1);
    expect((body.data.steps[0] as { tool: string }).tool).toBe("device.app.open");
  });

  it("rejects execution if capability is missing", async () => {
    const account = await createAccount(harness, "test2@nexus.fr");
    const { device } = await registerDevice(harness, account, {
      name: "PC",
      role: "CLIENT",
      permissions: [], // No permissions
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks/instruct",
      headers: account.authorization,
      payload: {
        instruction: "open Chrome on my Windows PC",
        originClientDeviceId: device.id,
      },
    });

    expect(response.statusCode).toBe(403);
  });
});

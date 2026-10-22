import { describe, expect, it } from "vitest";
import type { MessageView } from "@nexus/client-core";
import { InvalidTaskDraftError, taskRequestBody } from "../src/lib/tasks.js";
import { mergeHistory } from "../src/lib/history.js";

/**
 * Outgoing requests to core and displayed state.
 *
 * Verifies requests express required capabilities rather than targeting specific devices.
 */

describe("task composition", () => {
  const draft = {
    title: "Run repository test suite",
    steps: [
      {
        description: "Execute pnpm test",
        requiredCapabilities: ["terminal.execute"],
        tool: "terminal.execute",
        arguments: { command: "pnpm", args: ["test"] },
      },
    ],
  };

  it("declares capabilities, never a worker destination", () => {
    const body = taskRequestBody(draft, "device-laptop");
    const serialized = JSON.stringify(body);

    for (const field of [
      "targetDeviceId",
      "deviceId",
      "workerDeviceId",
      "executeOn",
      "runOn",
      "selectedDeviceId",
    ]) {
      expect(serialized).not.toContain(field);
    }

    expect(body.steps[0]?.requiredCapabilities).toEqual(["terminal.execute"]);
  });

  it("transmits origin device indicating source rather than target", () => {
    const body = taskRequestBody(draft, "device-laptop");

    expect(body.originClientDeviceId).toBe("device-laptop");
  });

  it("rejects step missing required capabilities", () => {
    expect(() =>
      taskRequestBody(
        {
          title: "Vague task",
          steps: [{ description: "do the necessary", requiredCapabilities: [], tool: "x" }],
        },
        "device-laptop",
      ),
    ).toThrow(InvalidTaskDraftError);
  });

  it("rejects empty title and step-less task", () => {
    expect(() => taskRequestBody({ title: "  ", steps: draft.steps }, "d")).toThrow(
      InvalidTaskDraftError,
    );
    expect(() => taskRequestBody({ title: "Title", steps: [] }, "d")).toThrow(
      InvalidTaskDraftError,
    );
  });

  it("normalizes absent dependencies", () => {
    const body = taskRequestBody(draft, "device-laptop");

    expect(body.steps[0]?.dependsOn).toEqual([]);
  });

  it("does not fabricate optional fields", () => {
    const body = taskRequestBody(draft, "device-laptop");

    expect(Object.keys(body.steps[0] ?? {})).not.toContain("riskLevel");
    expect(Object.keys(body)).not.toContain("conversationId");
  });
});

describe("history and live stream merging", () => {
  const live: MessageView[] = [
    {
      id: "m2",
      role: "assistant",
      content: "Starting now",
      streaming: true,
      createdAt: "2026-09-02T10:00:02.000Z",
      originClientDeviceId: null,
    },
  ];

  const history = [
    {
      id: "m1",
      role: "user",
      content: "Run tests",
      createdAt: "2026-09-02T10:00:01.000Z",
      originClientDeviceId: "device-iphone",
    },
    {
      id: "m2",
      role: "assistant",
      content: "Start",
      createdAt: "2026-09-02T10:00:02.000Z",
    },
  ];

  it("does not duplicate messages present in both sources", () => {
    const thread = mergeHistory(live, history);

    expect(thread.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("live stream takes precedence over history", () => {
    const thread = mergeHistory(live, history);
    const last = thread.at(-1);

    expect(last?.content).toBe("Starting now");
    expect(last?.streaming).toBe(true);
  });

  it("preserves origin client device from history", () => {
    const thread = mergeHistory(live, history);

    expect(thread[0]?.originClientDeviceId).toBe("device-iphone");
  });

  it("orders chronologically, including identical timestamps", () => {
    const sameTimestamp = [
      { id: "b", role: "user", content: "second", createdAt: "2026-09-02T10:00:00.000Z" },
      { id: "a", role: "user", content: "first", createdAt: "2026-09-02T10:00:00.000Z" },
    ];

    expect(mergeHistory([], sameTimestamp).map((message) => message.id)).toEqual(["a", "b"]);
  });

  it("returns empty array for empty inputs", () => {
    expect(mergeHistory([], [])).toEqual([]);
  });
});

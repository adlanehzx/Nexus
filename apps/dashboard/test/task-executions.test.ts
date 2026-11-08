import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardApi, createSession, type TaskExecution } from "../src/lib/api.js";
import { ExecutionInspection } from "../src/ui/sections/tasks.js";

const execution: TaskExecution = {
  id: "execution-1",
  stepId: "step-1",
  deviceId: "worker-1",
  attempt: 2,
  status: "failed",
  startedAt: "2026-11-08T10:00:00Z",
  completedAt: "2026-11-08T10:00:02Z",
  durationMs: 2000,
  input: { command: "test" },
  result: { exitCode: 1, stdout: "first line\n<script>alert(1)</script>", stderr: "failed\n" },
  error: { code: "PROCESS_EXIT", message: "Process failed" },
};

afterEach(() => vi.unstubAllGlobals());

describe("execution history API", () => {
  async function setup(status = 200) {
    const fetch = vi.fn().mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/v1/auth/login") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                user: { id: "u-1", email: "admin@nexus.test" },
                tokens: { accessToken: "access", refreshToken: "refresh" },
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify(
            status === 200
              ? { data: [execution], meta: { nextCursor: "next/run?", total: 26 } }
              : { error: { message: "History unavailable" } },
          ),
          { status },
        ),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const session = createSession("http://localhost:3000", () => undefined);
    await session.login("admin@nexus.test", "secret");
    return { api: new DashboardApi(session), fetch };
  }

  it("preserves pagination metadata, attempt details and complete output", async () => {
    const { api, fetch } = await setup();
    const page = await api.taskExecutions("task/one?");
    expect(page).toEqual({ data: [execution], meta: { nextCursor: "next/run?", total: 26 } });
    await api.taskExecutions("task/one?", page.meta.nextCursor ?? undefined);
    const url = new URL(String(fetch.mock.calls.at(-1)?.[0]));
    expect(url.pathname).toBe("/api/v1/tasks/task%2Fone%3F/executions");
    expect(url.searchParams.get("cursor")).toBe("next/run?");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it.each([403, 500])("propagates history errors (%s) for the retry UI", async (status) => {
    const { api } = await setup(status);
    await expect(api.taskExecutions("task-1")).rejects.toThrow(
      status === 403 ? "This section is not accessible with this account." : "History unavailable",
    );
  });
});

describe("execution inspection", () => {
  const render = (overrides: Partial<TaskExecution> = {}) =>
    renderToStaticMarkup(
      createElement(ExecutionInspection, { execution: { ...execution, ...overrides } }),
    );

  it("renders attempt, timestamps, duration, errors and escaped logs with SVG status", () => {
    const html = render();
    for (const value of [
      "execution-1",
      "Attempt",
      "worker-1",
      "step-1",
      "2.0 s",
      "Exit code",
      "PROCESS_EXIT",
      execution.startedAt,
      execution.completedAt ?? "",
      "stdout",
      "stderr",
      "first line",
    ])
      expect(html).toContain(value);
    expect(html).toContain("<svg");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it.each([null, "text result", { exitCode: null }, { stdout: 12 }])(
    "handles non-process results without inventing an exit code: %s",
    (result) => {
      const html = render({
        result,
        completedAt: null,
        durationMs: null,
        status: "running",
        error: null,
      });
      expect(html).toContain("Not available");
      expect(html).toContain("Not completed");
      expect(html).toContain("No output recorded.");
    },
  );

  it("retains zero exit codes and long multiline output", () => {
    const output = "line\n".repeat(1000);
    const html = render({
      result: { exitCode: 0, stdout: output, stderr: "" },
      status: "succeeded",
      error: null,
    });
    expect(html).toContain("<dd>0</dd>");
    expect(html).toContain(output);
  });
});

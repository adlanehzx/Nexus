import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionControlPort, SubmitMission } from "@nexus/mission-control-client";
import type { LLMProvider } from "@nexus/llm";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

const missionId = "33333333-3333-4333-8333-333333333333";
let submitted: SubmitMission | undefined;

const engine = {
  health: vi.fn().mockResolvedValue({
    status: "ready" as const,
    worker_enabled: true,
    worker_concurrency: 2,
    scheduler_enabled: true,
    profiles: ["antigravity", "claude", "codex"],
  }),
  settings: vi.fn().mockResolvedValue({
    task_timeout_seconds: 1800,
    max_attempts: 3,
    retry_delay_seconds: 10,
    context_budget_chars: 60000,
    quality_review: true,
    research_priority: ["antigravity", "claude", "codex"],
    review_priority: ["claude", "codex", "antigravity"],
    synthesis_priority: ["claude", "antigravity", "codex"],
  }),
  updateSettings: vi.fn(),
  submitMission: vi.fn((input: SubmitMission) => {
    submitted = input;
    return Promise.resolve({ mission_id: missionId, replayed: false });
  }),
  getMission: vi.fn(() =>
    Promise.resolve({
      id: missionId,
      external_key: submitted?.external_key ?? "wrong-owner",
      title: submitted?.title ?? "Mission",
      workspace: submitted?.workspace ?? "/tmp",
      state: "succeeded",
      created_at: "2026-10-19T10:00:00+00:00",
      updated_at: "2026-10-19T10:01:00+00:00",
      tasks: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          mission_id: missionId,
          task_key: "nexus_final_synthesis",
          ordinal: 2,
          profile_key: "codex",
          state: "succeeded",
          result_json: '{"response":"Verified final response"}',
          error_json: null,
          created_at: "2026-10-19T10:00:00+00:00",
          updated_at: "2026-10-19T10:01:00+00:00",
          depends_on: [],
          attempts: [],
        },
      ],
    }),
  ),
  listMissions: vi.fn().mockResolvedValue([]),
  createSchedule: vi.fn(),
  getSchedule: vi.fn(),
  listSchedules: vi.fn().mockResolvedValue([]),
  listScheduleRuns: vi.fn().mockResolvedValue([]),
  pauseSchedule: vi.fn(),
  resumeSchedule: vi.fn(),
  agents: vi.fn().mockResolvedValue({ worker_enabled: true, configured: [], available: [] }),
  registerAgent: vi.fn().mockResolvedValue({
    worker_enabled: true,
    configured: [],
    available: [],
  }),
  createAgent: vi.fn().mockResolvedValue({
    worker_enabled: true,
    configured: [],
    available: [],
  }),
  updateAgentProfile: vi.fn().mockResolvedValue({
    worker_enabled: true,
    configured: [],
    available: [],
  }),
  disableAgent: vi.fn().mockResolvedValue({
    worker_enabled: true,
    configured: [],
    available: [],
  }),
  testAgentProfile: vi.fn().mockResolvedValue({ ok: true as const, response: "NEXUS_ACP_OK" }),
  updateAgentHealth: vi.fn().mockResolvedValue({
    worker_enabled: true,
    configured: [],
    available: [],
  }),
  verifyAudit: vi.fn(),
  createPaperAccount: vi.fn(),
  getPaperAccount: vi.fn(),
  listPaperAccounts: vi.fn().mockResolvedValue([]),
  createPaperMarket: vi.fn(),
  getPaperMarket: vi.fn(),
  listPaperMarkets: vi.fn().mockResolvedValue([]),
  addPaperQuote: vi.fn(),
  submitResearchMission: vi.fn(),
  getResearchRun: vi.fn(),
  listResearchRuns: vi.fn().mockResolvedValue([]),
} satisfies MissionControlPort;

let harness: ApiHarness;
let account: Account;

beforeEach(async () => {
  submitted = undefined;
  vi.clearAllMocks();
  harness = await makeApi({ missionControl: engine });
  account = await createAccount(harness, "orchestrator@example.org");
});

afterEach(async () => harness.close());

describe("NEXUS orchestrator facade", () => {
  it("transforms a single message into an ACP DAG then exposes only the synthesis", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/messages",
      headers: account.authorization,
      payload: { message: "Analyze this repository and suggest three improvements." },
    });
    expect(created.statusCode).toBe(202);
    expect(submitted?.tasks.at(-1)).toMatchObject({
      key: "nexus_final_synthesis",
      profile: "claude",
      fallback_profiles: ["antigravity", "codex"],
      context_budget_chars: 80_000,
    });
    expect((submitted?.tasks.at(-1)?.depends_on ?? []).length).toBeGreaterThan(0);
    expect(submitted?.tasks).toContainEqual(
      expect.objectContaining({
        key: "nexus_quality_review_1",
        profile: "claude",
        context_budget_chars: 80_000,
      }),
    );
    expect(submitted?.tasks.at(-1)?.depends_on).toContain("nexus_quality_review_1");

    const status = await harness.app.inject({
      method: "GET",
      url: `/api/v1/orchestrator/missions/${missionId}`,
      headers: account.authorization,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toMatchObject({
      state: "succeeded",
      response: "Verified final response",
    });
  });

  it("requires a user session", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/messages",
      payload: { message: "test" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("injects persistent memory into ACP tasks without treating it as an instruction", async () => {
    await harness.services.memoryService.remember({
      userId: account.userId,
      content: "Always deliver a final summary in English.",
      layer: "PREFERENCE",
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/messages",
      headers: account.authorization,
      payload: { message: "Analyze the project." },
    });

    expect(response.statusCode).toBe(202);
    expect(submitted?.tasks[0]?.instruction).toContain("<USER_CONTEXT>");
    expect(submitted?.tasks[0]?.instruction).toContain(
      "Always deliver a final summary in English.",
    );
    expect(submitted?.tasks[0]?.instruction).toContain("untrusted data");
  });

  it("routes a browser mission to an agent equipped with local harness", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/messages",
      headers: account.authorization,
      payload: {
        message: "Open the browser, visit example.com, and verify the page title.",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(submitted?.tasks[0]).toMatchObject({
      profile: "codex",
      fallback_profiles: ["claude"],
    });
    expect(submitted?.tasks[0]?.instruction).toContain("browser-harness");
  });

  it("creates a durable schedule from chat when timing request is explicit", async () => {
    await harness.close();
    const scheduleId = "88888888-8888-4888-8888-888888888888";
    const scheduledLlm: LLMProvider = {
      id: "scheduled-test",
      model: "scheduled-test",
      capabilities: {
        tools: false,
        vision: false,
        structuredOutput: true,
        maxContextTokens: 100_000,
      },
      countTokens: () => Promise.resolve(10),
      structuredOutput: <T>() =>
        Promise.resolve({
          title: "Daily watch",
          tasks: [
            {
              key: "daily_watch",
              profile: "antigravity",
              instruction: "Analyze new information and report changes.",
              depends_on: [],
            },
          ],
          schedule: {
            kind: "cron",
            cron_expression: "0 8 * * *",
            timezone: "Europe/Paris",
          },
        } as T),
      generate: () =>
        Promise.resolve({
          content: [],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "scheduled-test",
        }),
      stream: async function* () {
        await Promise.resolve();
        yield { type: "text_delta", delta: "" } as const;
      },
    };
    engine.createSchedule.mockResolvedValueOnce({
      id: scheduleId,
      name: "Daily watch",
      state: "active",
      schedule_kind: "cron",
      run_at: null,
      cron_expression: "0 8 * * *",
      timezone: "Europe/Paris",
      catch_up_policy: "latest",
      max_catch_up: 10,
      max_concurrency: 1,
      misfire_grace_seconds: 300,
      mission: {
        external_key: "nexus-owner-schedule",
        title: "Daily watch",
        workspace: "/tmp/nexus",
        tasks: [],
      },
      next_run_at: "2030-01-01T07:00:00+00:00",
      last_scheduled_at: null,
      created_at: "2026-10-20T10:00:00+00:00",
      updated_at: "2026-10-20T10:00:00+00:00",
    });
    harness = await makeApi({ missionControl: engine, llmProvider: scheduledLlm });
    account = await createAccount(harness, "scheduled-chat@example.org");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/messages",
      headers: account.authorization,
      payload: {
        message: "Every day at 8 AM, monitor new information.",
        timezone: "Europe/Paris",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data).toMatchObject({
      missionId: scheduleId,
      state: "scheduled",
    });
    expect(response.json().data.response).toContain("Schedule");
    expect(engine.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "Europe/Paris",
        cron_expression: "0 8 * * *",
      }),
    );
    expect(engine.submitMission).not.toHaveBeenCalled();
  });

  it("allows administrator to inspect and register NEXUS ACP profiles", async () => {
    const listed = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/agents",
      headers: account.authorization,
    });
    expect(listed.statusCode).toBe(200);
    expect(engine.agents).toHaveBeenCalledOnce();

    const registered = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/agents",
      headers: account.authorization,
      payload: { key: "new-agent", agent_profile_id: "profile-123" },
    });
    expect(registered.statusCode).toBe(201);
    expect(engine.registerAgent).toHaveBeenCalledWith({
      key: "new-agent",
      agent_profile_id: "profile-123",
    });
  });

  it("reserves agent registry to administrator account", async () => {
    const member = await createAccount(harness, "member-agents@example.org");
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/agents",
      headers: member.authorization,
    });
    expect(response.statusCode).toBe(403);
  });

  it("creates an ACP profile from NEXUS without receiving secrets", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/agents/create",
      headers: account.authorization,
      payload: {
        key: "claude-review",
        name: "Claude-Review",
        template_profile_id: "profile-claude",
        model: "claude-opus",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(engine.createAgent).toHaveBeenCalledWith({
      key: "claude-review",
      name: "Claude-Review",
      template_profile_id: "profile-claude",
      model: "claude-opus",
    });
    expect(JSON.stringify(engine.createAgent.mock.calls)).not.toMatch(/token|secret|password/i);
  });

  it("configures, tests, and disables an ACP profile from dashboard", async () => {
    const profile = {
      name: "Claude Review",
      command: "/usr/bin/npx",
      args: ["-y", "claude-agent-acp"],
      model: "opus",
    };
    const updated = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/orchestrator/agents/profiles/claude",
      headers: account.authorization,
      payload: profile,
    });
    expect(updated.statusCode).toBe(200);
    expect(engine.updateAgentProfile).toHaveBeenCalledWith("claude", profile);

    const tested = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/agents/profiles/claude/test",
      headers: account.authorization,
      payload: { workspace: "/tmp/nexus", prompt: "ping", timeout_seconds: 30 },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().data.response).toBe("NEXUS_ACP_OK");

    const disabled = await harness.app.inject({
      method: "DELETE",
      url: "/api/v1/orchestrator/agents/claude",
      headers: account.authorization,
    });
    expect(disabled.statusCode).toBe(200);
    expect(engine.disableAgent).toHaveBeenCalledWith("claude");
  });

  it("reads and saves orchestration settings", async () => {
    const settings = await engine.settings();
    engine.updateSettings.mockResolvedValueOnce(settings);
    const response = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/orchestrator/settings",
      headers: account.authorization,
      payload: settings,
    });
    expect(response.statusCode).toBe(200);
    expect(engine.updateSettings).toHaveBeenCalledWith(settings);
  });
});

import { describe, expect, it } from "vitest";
import type { RuntimeSettings } from "@nexus/mission-control-client";
import { AgentCollaborationService } from "../src/services/agent-collaboration.js";
import { AgentRouter } from "../src/services/agent-router.js";

const settings: RuntimeSettings = {
  task_timeout_seconds: 1800,
  max_attempts: 3,
  retry_delay_seconds: 10,
  context_budget_chars: 60000,
  quality_review: true,
  research_priority: ["antigravity", "claude", "codex"],
  review_priority: ["claude", "codex", "antigravity"],
  synthesis_priority: ["claude", "antigravity", "codex"],
};

describe("AgentCollaborationService", () => {
  const service = new AgentCollaborationService();
  const router = new AgentRouter();

  it("faithfully extracts structured JSON output", () => {
    const raw = JSON.stringify({
      summary: "Successful refactoring of the authentication module.",
      payloadType: "code_patch",
      confidenceScore: 0.95,
      assumptions: ["Node 26 LTS used", "256-bit JWT keys"],
      openQuestions: ["Should legacy tokens be migrated?"],
      proposedSubtasks: [
        {
          key: "verify_jwt_migration",
          title: "Verify JWT migration",
          instruction: "Test backward compatibility with legacy tokens.",
          reason: "Avoid disconnecting existing sessions.",
          priority: "recommended",
        },
      ],
      artifacts: [
        {
          name: "auth.patch",
          description: "Signature fix",
        },
      ],
    });

    const parsed = service.parseTaskOutput(raw);
    expect(parsed.payloadType).toBe("code_patch");
    expect(parsed.confidenceScore).toBe(0.95);
    expect(parsed.assumptions).toEqual(["Node 26 LTS used", "256-bit JWT keys"]);
    expect(parsed.proposedSubtasks).toHaveLength(1);
    expect(parsed.proposedSubtasks[0]?.key).toBe("verify_jwt_migration");
  });

  it("semantically extracts assumptions and questions from free markdown", () => {
    const text = `
    I analyzed the system architecture.
    
    ## Assumptions
    - PostgreSQL is operational on localhost:5432
    - Redis is not used for durable persistence
    
    ## Open questions
    - What is the target request throughput?
    
    Confidence: 90%
    `;

    const parsed = service.parseTaskOutput(text);
    expect(parsed.confidenceScore).toBe(0.9);
    expect(parsed.assumptions).toContain("PostgreSQL is operational on localhost:5432");
    expect(parsed.openQuestions).toContain("What is the target request throughput?");
  });

  it("formats structured upstream context with artifacts and indicators", () => {
    const context = service.formatStructuredUpstreamContext([
      {
        taskKey: "investigate",
        profileKey: "codex",
        output: {
          summary: "Codebase explored, no obsolete components.",
          payloadType: "audit_report",
          confidenceScore: 0.92,
          assumptions: ["TypeScript version 5.8"],
          openQuestions: [],
          proposedSubtasks: [],
          artifacts: [],
        },
        artifacts: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            missionKey: "m-1",
            taskKey: "investigate",
            name: "report.json",
            relativePath: "investigate/report.json",
            uri: "artifact://investigate/report.json",
            mimeType: "application/json",
            sizeBytes: 2048,
            sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            description: "Analysis details",
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ],
      },
    ]);

    expect(context).toContain("<STRUCTURED_UPSTREAM_CONTEXT>");
    expect(context).toContain(
      "[TASK: investigate | AGENT: codex | TYPE: audit_report | CONFIDENCE: 92%]",
    );
    expect(context).toContain("artifact://investigate/report.json");
    expect(context).toContain("TypeScript version 5.8");
    expect(context).toContain("</STRUCTURED_UPSTREAM_CONTEXT>");
  });

  it("detects formal contradiction and generates a neutral arbitration task", async () => {
    const upstream = [
      {
        taskKey: "propose_solution",
        profileKey: "antigravity",
        output: {
          summary: "The lockless solution is safe and sufficient.",
          payloadType: "hypothesis" as const,
          confidenceScore: 0.85,
          assumptions: [],
          openQuestions: [],
          proposedSubtasks: [],
          artifacts: [],
        },
      },
      {
        taskKey: "security_review",
        profileKey: "claude",
        output: {
          summary:
            "Major contradiction: the lack of locking introduces a critical race condition.",
          payloadType: "contradiction_claim" as const,
          confidenceScore: 0.95,
          assumptions: [],
          openQuestions: [],
          proposedSubtasks: [],
          artifacts: [],
        },
      },
    ];

    const debate = service.detectContradiction(upstream);
    expect(debate).not.toBeNull();
    expect(debate?.severity).toBe("high");

    if (debate) {
      const arbitration = await service.generateArbitrationTask(
        debate,
        ["antigravity", "claude", "codex"],
        settings,
        router,
      );

      expect(arbitration.key).toBe("nexus_cross_critique_arbitration");
      expect(arbitration.depends_on).toEqual(["propose_solution", "security_review"]);
      expect(arbitration.instruction).toContain("neutral arbitrator");
      // Prefers codex as neutral third party
      expect(arbitration.profile).toBe("codex");
    }
  });

  it("dynamically integrates priority subtask proposals into the DAG", async () => {
    const existingTasks = [
      {
        key: "initial_dev",
        profile: "codex",
        fallback_profiles: [],
        depends_on: [],
        timeout_seconds: 600,
        max_attempts: 1,
        retry_delay_seconds: 5,
        context_budget_chars: 40000,
        instruction: "Develop feature",
      },
      {
        key: "nexus_final_synthesis",
        profile: "claude",
        fallback_profiles: [],
        depends_on: ["initial_dev"],
        timeout_seconds: 600,
        max_attempts: 1,
        retry_delay_seconds: 5,
        context_budget_chars: 40000,
        instruction: "Synthesize",
      },
    ];

    const proposals = [
      {
        key: "benchmark_stress_test",
        title: "Load test",
        instruction: "Measure latency at 1000 req/s",
        reason: "Verify scaling",
        priority: "critical" as const,
      },
      {
        key: "optional_styling",
        title: "CSS polish",
        instruction: "Change color",
        reason: "Aesthetics",
        priority: "optional" as const,
      },
    ];

    const updated = await service.incorporateSubtaskProposals({
      proposals,
      existingTasks,
      availableProfiles: ["antigravity", "claude", "codex"],
      router,
      parentTaskKey: "initial_dev",
      settings,
    });

    // Only the critical subtask should be incorporated; optional is ignored
    expect(updated).toHaveLength(3);
    const benchmarkTask = updated.find((t) => t.key === "benchmark_stress_test");
    expect(benchmarkTask).toBeDefined();
    expect(benchmarkTask?.depends_on).toEqual(["initial_dev"]);

    // The final synthesis must now depend on the new subtask
    const synthesis = updated.find((t) => t.key === "nexus_final_synthesis");
    expect(synthesis?.depends_on).toContain("benchmark_stress_test");
  });
});

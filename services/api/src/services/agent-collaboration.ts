import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MissionTaskInput, RuntimeSettings } from "@nexus/mission-control-client";
import type { AgentRouter } from "./agent-router.js";
import type { SharedArtifactRecord } from "./shared-artifacts.js";

export const payloadTypeSchema = z.enum([
  "text",
  "code_patch",
  "audit_report",
  "critique",
  "browser_findings",
  "hypothesis",
  "contradiction_claim",
]);

export type PayloadType = z.infer<typeof payloadTypeSchema>;

export const proposedSubtaskSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,47}$/)
    .describe("Subtask key"),
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(20_000),
  reason: z.string().max(1000),
  priority: z.enum(["critical", "recommended", "optional"]).default("recommended"),
  profile: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
});

export type ProposedSubtask = z.infer<typeof proposedSubtaskSchema>;

export const structuredTaskOutputSchema = z.object({
  summary: z.string().min(1).max(30_000),
  payloadType: payloadTypeSchema.default("text"),
  confidenceScore: z.number().min(0).max(1).default(0.85),
  data: z.record(z.string(), z.unknown()).optional(),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  proposedSubtasks: z.array(proposedSubtaskSchema).default([]),
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        description: z.string().max(500),
        mimeType: z.string().optional(),
        content: z.string().optional(),
      }),
    )
    .default([]),
});

export type StructuredTaskOutput = z.infer<typeof structuredTaskOutputSchema>;

export interface CrossCritiqueDebate {
  id: string;
  taskA: { key: string; profile: string; summary: string; confidence: number };
  taskB: { key: string; profile: string; summary: string; confidence: number };
  issue: string;
  severity: "high" | "medium";
  recommendation: string;
}

export interface UpstreamTaskContext {
  taskKey: string;
  profileKey: string;
  output: StructuredTaskOutput;
  artifacts?: SharedArtifactRecord[];
}

/**
 * Inter-agent collaboration service:
 * - Output parsing and structuring
 * - Enriched context formatting (artifacts, confidence, assumptions)
 * - Contradiction detection and adversarial arbitration
 * - Dynamic integration of proposed subtasks
 */
export class AgentCollaborationService {
  /**
   * Parses and extracts structured output from raw result (JSON or text).
   */
  parseTaskOutput(raw: unknown): StructuredTaskOutput {
    if (raw === null || raw === undefined) {
      return {
        summary: "No result provided.",
        payloadType: "text",
        confidenceScore: 0.5,
        assumptions: [],
        openQuestions: [],
        proposedSubtasks: [],
        artifacts: [],
      };
    }

    // 1. If already a conforming object
    if (typeof raw === "object") {
      const parsed = structuredTaskOutputSchema.safeParse(raw);
      if (parsed.success) return parsed.data;

      // If object with 'response' property
      if ("response" in raw && typeof raw.response === "string") {
        return this.parseTaskOutput(raw.response);
      }
    }

    if (typeof raw !== "string") {
      return {
        summary: JSON.stringify(raw),
        payloadType: "text",
        confidenceScore: 0.5,
        assumptions: [],
        openQuestions: [],
        proposedSubtasks: [],
        artifacts: [],
      };
    }

    const text = raw.trim();

    // 2. Attempt to extract a full JSON block or a ```json ... ``` block
    const jsonMatch = /```json\s*([\s\S]*?)\s*```/.exec(text) ?? /^(\{[\s\S]*\})$/.exec(text);
    if (jsonMatch?.[1]) {
      try {
        const obj = JSON.parse(jsonMatch[1]) as unknown;
        const parsed = structuredTaskOutputSchema.safeParse(obj);
        if (parsed.success) return parsed.data;

        if (typeof obj === "object" && obj !== null && "response" in obj) {
          return this.parseTaskOutput(obj.response);
        }
      } catch {
        // Fall through to semantic extraction
      }
    }

    // 3. Semantic extraction based on common markdown headers
    const assumptions = extractMarkdownList(text, ["assumptions", "hypotheses"]);
    const openQuestions = extractMarkdownList(text, [
      "open questions",
      "uncertainties",
      "questions",
    ]);

    // Payload type detection
    let payloadType: PayloadType = "text";
    if (/diff\s+--git|@@\s+-[0-9]+,[0-9]+\s+\+[0-9]+,[0-9]+\s+@@/i.test(text)) {
      payloadType = "code_patch";
    } else if (
      /\b(vulnerability|flaw|security\s+audit|compliance\s+audit|cve|injection)\b/i.test(
        text,
      )
    ) {
      payloadType = "audit_report";
    } else if (/\b(contradiction|disagreement|invalid|major\s+error|refutation)\b/i.test(text)) {
      payloadType = "contradiction_claim";
    } else if (/\b(critique|counter-analysis|review|verification)\b/i.test(text)) {
      payloadType = "critique";
    } else if (/\b(browser|chromium|web\s+page|url|page\s+title)\b/i.test(text)) {
      payloadType = "browser_findings";
    }

    // Confidence detection
    let confidenceScore = 0.85;
    const confidenceMatch = /\bconfidence\s*:\s*([0-9]{1,3})\s*%/i.exec(text);
    if (confidenceMatch?.[1]) {
      confidenceScore = Math.min(1, Math.max(0, Number(confidenceMatch[1]) / 100));
    }

    return {
      summary: text,
      payloadType,
      confidenceScore,
      assumptions,
      openQuestions,
      proposedSubtasks: [],
      artifacts: [],
    };
  }

  /**
   * Builds the structured context block injected into instructions of downstream tasks.
   */
  formatStructuredUpstreamContext(upstream: UpstreamTaskContext[]): string {
    if (upstream.length === 0) return "";

    const lines: string[] = ["<STRUCTURED_UPSTREAM_CONTEXT>"];
    for (const item of upstream) {
      const confPct = Math.round(item.output.confidenceScore * 100);
      lines.push(
        `[TASK: ${item.taskKey} | AGENT: ${item.profileKey} | TYPE: ${item.output.payloadType} | CONFIDENCE: ${confPct}%]`,
      );
      lines.push("SUMMARY:");
      lines.push(item.output.summary);

      if (item.output.assumptions.length > 0) {
        lines.push("ASSUMPTIONS:");
        for (const ass of item.output.assumptions) lines.push(`- ${ass}`);
      }

      if (item.output.openQuestions.length > 0) {
        lines.push("OPEN QUESTIONS:");
        for (const q of item.output.openQuestions) lines.push(`- ${q}`);
      }

      if (item.artifacts && item.artifacts.length > 0) {
        lines.push("AVAILABLE ARTIFACTS:");
        for (const art of item.artifacts) {
          const kb = (art.sizeBytes / 1024).toFixed(1);
          lines.push(
            `- ${art.uri} (${art.mimeType}, ${kb} KB, sha256: ${art.sha256.slice(0, 8)}…): ${art.description}`,
          );
        }
      }
      lines.push("");
    }
    lines.push("</STRUCTURED_UPSTREAM_CONTEXT>");
    return lines.join("\n");
  }

  /**
   * Detects contradictions or substantive disagreements between upstream tasks.
   */
  detectContradiction(tasks: UpstreamTaskContext[]): CrossCritiqueDebate | null {
    if (tasks.length < 2) return null;

    // 1. Find a task that explicitly states a contradiction or refutation
    const contradictionTask = tasks.find(
      (t) =>
        t.output.payloadType === "contradiction_claim" ||
        /\b(invalid|dangerous|incorrect|major\s+contradiction|false\s+conclusion|refutes)\b/i.test(
          t.output.summary,
        ),
    );

    if (contradictionTask) {
      // Find the previous contradicted task
      const otherTask = tasks.find((t) => t.taskKey !== contradictionTask.taskKey);
      if (otherTask) {
        return {
          id: randomUUID(),
          taskA: {
            key: otherTask.taskKey,
            profile: otherTask.profileKey,
            summary: otherTask.output.summary.slice(0, 300),
            confidence: otherTask.output.confidenceScore,
          },
          taskB: {
            key: contradictionTask.taskKey,
            profile: contradictionTask.profileKey,
            summary: contradictionTask.output.summary.slice(0, 300),
            confidence: contradictionTask.output.confidenceScore,
          },
          issue: `Contradictory divergence detected between ${otherTask.taskKey} and ${contradictionTask.taskKey}.`,
          severity: "high",
          recommendation:
            "Arbitration required to resolve contradictory conclusions before final synthesis.",
        };
      }
    }

    return null;
  }

  /**
   * Generates a cross-critique debate arbitration task when divergence is detected.
   */
  async generateArbitrationTask(
    debate: CrossCritiqueDebate,
    availableProfiles: string[],
    settings: RuntimeSettings,
    router: AgentRouter,
  ): Promise<MissionTaskInput> {
    // Prefer a neutral arbiter (different profile from taskA and taskB if possible)
    const neutralProfiles = availableProfiles.filter(
      (p) => p !== debate.taskA.profile && p !== debate.taskB.profile,
    );
    const candidateProfiles = neutralProfiles.length > 0 ? neutralProfiles : availableProfiles;

    const arbiterProfile = await router.bestProfileFor(
      candidateProfiles,
      "Neutral contradictory arbitration and dispute resolution",
      candidateProfiles[0] ?? "claude",
    );

    const fallbacks = await router.fallbackOrderFor(
      arbiterProfile,
      availableProfiles,
      "Neutral contradictory arbitration",
    );

    const instruction = [
      "You are the neutral arbitrator for NEXUS.",
      "Two agents issued divergent conclusions on this mission:",
      `- Agent A (${debate.taskA.profile}, task "${debate.taskA.key}", confidence ${Math.round(debate.taskA.confidence * 100)}%):`,
      `  "${debate.taskA.summary}"`,
      `- Agent B (${debate.taskB.profile}, task "${debate.taskB.key}", confidence ${Math.round(debate.taskB.confidence * 100)}%):`,
      `  "${debate.taskB.summary}"`,
      "",
      "ARBITRATION INSTRUCTIONS:",
      "1. Rigorously analyze evidence, facts, and artifacts provided by both parties.",
      "2. Untangle factual or methodological contradictions.",
      "3. Identify unsubstantiated risks vs proven guarantees.",
      "4. Formulate a unified, clear, actionable arbitration verdict that the final synthesizer can rely on with full confidence.",
    ].join("\n");

    return {
      key: "nexus_cross_critique_arbitration",
      profile: arbiterProfile,
      fallback_profiles: fallbacks,
      depends_on: [debate.taskA.key, debate.taskB.key],
      timeout_seconds: settings.task_timeout_seconds,
      max_attempts: 2,
      retry_delay_seconds: settings.retry_delay_seconds,
      context_budget_chars: Math.max(settings.context_budget_chars, 80_000),
      instruction,
    };
  }

  /**
   * Validates and incorporates subtask proposals from an agent into the execution DAG.
   */
  async incorporateSubtaskProposals(options: {
    proposals: ProposedSubtask[];
    existingTasks: MissionTaskInput[];
    availableProfiles: string[];
    router: AgentRouter;
    parentTaskKey: string;
    settings: RuntimeSettings;
    maxAdditional?: number;
  }): Promise<MissionTaskInput[]> {
    const maxAdditional = options.maxAdditional ?? 3;
    const existingKeys = new Set(options.existingTasks.map((t) => t.key));

    // Filter valid, high-priority proposals (critical or recommended)
    const candidates = options.proposals
      .filter((p) => p.priority === "critical" || p.priority === "recommended")
      .filter((p) => !existingKeys.has(p.key))
      .slice(0, maxAdditional);

    if (candidates.length === 0) return options.existingTasks;

    const newTasks: MissionTaskInput[] = [];

    for (const proposal of candidates) {
      // Determine profile (either specified or automatically routed)
      let profile = proposal.profile;
      if (!profile || !options.availableProfiles.includes(profile)) {
        profile = await options.router.bestProfileFor(
          options.availableProfiles,
          proposal.instruction,
          options.availableProfiles[0] ?? "codex",
        );
      }

      const fallbacks = await options.router.fallbackOrderFor(
        profile,
        options.availableProfiles,
        proposal.instruction,
      );

      const dependsOn =
        proposal.depends_on && proposal.depends_on.length > 0
          ? proposal.depends_on.filter((d) => existingKeys.has(d))
          : [options.parentTaskKey];

      newTasks.push({
        key: proposal.key,
        profile,
        fallback_profiles: fallbacks,
        depends_on: dependsOn,
        timeout_seconds: options.settings.task_timeout_seconds,
        max_attempts: 2,
        retry_delay_seconds: options.settings.retry_delay_seconds,
        context_budget_chars: options.settings.context_budget_chars,
        instruction: proposal.instruction,
      });

      existingKeys.add(proposal.key);
    }

    // Re-adjust dependencies of nexus_final_synthesis and nexus_quality_review to await new subtasks
    const newTaskKeys = newTasks.map((t) => t.key);
    const updatedExisting = options.existingTasks.map((task) => {
      if (task.key === "nexus_final_synthesis" || task.key.startsWith("nexus_quality_review")) {
        const currentDeps = task.depends_on ?? [];
        return {
          ...task,
          depends_on: [...new Set([...currentDeps, ...newTaskKeys])],
        };
      }
      return task;
    });

    return [...updatedExisting, ...newTasks];
  }
}

function extractMarkdownList(text: string, headerKeywords: string[]): string[] {
  const lines = text.split("\n");
  const result: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const headerText = trimmed.replace(/^#+\s*/, "").toLowerCase();
      inSection = headerKeywords.some((kw) => headerText.includes(kw));
      continue;
    }

    if (inSection) {
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        result.push(trimmed.slice(2).trim());
      } else if (/^[0-9]+\.\s+/.test(trimmed)) {
        result.push(trimmed.replace(/^[0-9]+\.\s+/, "").trim());
      } else if (trimmed.length === 0) {
        // Empty line
        continue;
      } else if (!trimmed.startsWith(" ") && !trimmed.startsWith("\t")) {
        // End of list section
        inSection = false;
      }
    }
  }

  return result;
}

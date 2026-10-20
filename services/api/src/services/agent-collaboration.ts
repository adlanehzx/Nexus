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
    .describe("Clé de la sous-tâche"),
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
 * Service de collaboration inter-agents :
 * - Parsing et structuration des sorties
 * - Formatage de contexte enrichi (artefacts, confiance, hypothèses)
 * - Détection des contradictions et arbitrage contradictoire
 * - Intégration dynamique des sous-tâches proposées
 */
export class AgentCollaborationService {
  /**
   * Analyse et extrait une sortie structurée depuis un résultat brut (JSON ou texte).
   */
  parseTaskOutput(raw: unknown): StructuredTaskOutput {
    if (raw === null || raw === undefined) {
      return {
        summary: "Aucun résultat fourni.",
        payloadType: "text",
        confidenceScore: 0.5,
        assumptions: [],
        openQuestions: [],
        proposedSubtasks: [],
        artifacts: [],
      };
    }

    // 1. Si déjà un objet conforme
    if (typeof raw === "object") {
      const parsed = structuredTaskOutputSchema.safeParse(raw);
      if (parsed.success) return parsed.data;

      // Si objet avec propriété 'response'
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

    // 2. Tenter d'extraire un bloc JSON complet ou un bloc ```json ... ```
    const jsonMatch =
      /```json\s*([\s\S]*?)\s*```/.exec(text) ?? /^(\{[\s\S]*\})$/.exec(text);
    if (jsonMatch?.[1]) {
      try {
        const obj = JSON.parse(jsonMatch[1]) as unknown;
        const parsed = structuredTaskOutputSchema.safeParse(obj);
        if (parsed.success) return parsed.data;

        if (typeof obj === "object" && obj !== null && "response" in obj) {
          return this.parseTaskOutput(obj.response);
        }
      } catch {
        // Poursuivre vers extraction sémantique
      }
    }

    // 3. Extraction sémantique basée sur les en-têtes markdown courants
    const assumptions = extractMarkdownList(text, ["hypothèses", "hypotheses", "assumptions"]);
    const openQuestions = extractMarkdownList(text, [
      "questions ouvertes",
      "incertitudes",
      "open questions",
    ]);

    // Détection du type de payload
    let payloadType: PayloadType = "text";
    if (/diff\s+--git|@@\s+-[0-9]+,[0-9]+\s+\+[0-9]+,[0-9]+\s+@@/i.test(text)) {
      payloadType = "code_patch";
    } else if (
      /\b(vulnérabilité|faille|audit\s+sécurité|audit\s+de\s+conformité|cve|injection)\b/i.test(text)
    ) {
      payloadType = "audit_report";
    } else if (/\b(contradiction|désaccord|invalide|erreur\s+majeure|réfutation)\b/i.test(text)) {
      payloadType = "contradiction_claim";
    } else if (/\b(critique|contre-analyse|revue|review|vérification)\b/i.test(text)) {
      payloadType = "critique";
    } else if (/\b(browser|navigateur|chromium|page\s+web|url|titre\s+page)\b/i.test(text)) {
      payloadType = "browser_findings";
    }

    // Détection de confiance
    let confidenceScore = 0.85;
    const confidenceMatch = /\bconfiance\s*:\s*([0-9]{1,3})\s*%/i.exec(text);
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
   * Construit le bloc de contexte structuré injecté dans les instructions des tâches aval.
   */
  formatStructuredUpstreamContext(upstream: UpstreamTaskContext[]): string {
    if (upstream.length === 0) return "";

    const lines: string[] = ["<STRUCTURED_UPSTREAM_CONTEXT>"];
    for (const item of upstream) {
      const confPct = Math.round(item.output.confidenceScore * 100);
      lines.push(
        `[TASK: ${item.taskKey} | AGENT: ${item.profileKey} | TYPE: ${item.output.payloadType} | CONFIANCE: ${confPct}%]`,
      );
      lines.push(`RÉSUMÉ :`);
      lines.push(item.output.summary);

      if (item.output.assumptions.length > 0) {
        lines.push(`HYPOTHÈSES :`);
        for (const ass of item.output.assumptions) lines.push(`- ${ass}`);
      }

      if (item.output.openQuestions.length > 0) {
        lines.push(`QUESTIONS OUVERTES :`);
        for (const q of item.output.openQuestions) lines.push(`- ${q}`);
      }

      if (item.artifacts && item.artifacts.length > 0) {
        lines.push(`ARTEFACTS DISPONIBLES :`);
        for (const art of item.artifacts) {
          const kb = (art.sizeBytes / 1024).toFixed(1);
          lines.push(
            `- ${art.uri} (${art.mimeType}, ${kb} KB, sha256: ${art.sha256.slice(0, 8)}…) : ${art.description}`,
          );
        }
      }
      lines.push("");
    }
    lines.push("</STRUCTURED_UPSTREAM_CONTEXT>");
    return lines.join("\n");
  }

  /**
   * Détecte les contradictions ou désaccords substantiels entre tâches amont.
   */
  detectContradiction(tasks: UpstreamTaskContext[]): CrossCritiqueDebate | null {
    if (tasks.length < 2) return null;

    // 1. Recherche d'une tâche qui formule explicitement une contradiction ou réfutation
    const contradictionTask = tasks.find(
      (t) =>
        t.output.payloadType === "contradiction_claim" ||
        /\b(invalide|dangereux|incorrect|contradiction\s+majeure|conclusion\s+fausse|réfute)\b/i.test(
          t.output.summary,
        ),
    );

    if (contradictionTask) {
      // Trouver la tâche précédente contredite
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
          issue: `Divergence contradictoire détectée entre ${otherTask.taskKey} et ${contradictionTask.taskKey}.`,
          severity: "high",
          recommendation:
            "Arbitrage requis pour trancher entre les conclusions contradictoires avant synthèse finale.",
        };
      }
    }

    return null;
  }

  /**
   * Génère une tâche d'arbitrage contradictoire (cross-critique debate) lorsqu'une divergence est détectée.
   */
  async generateArbitrationTask(
    debate: CrossCritiqueDebate,
    availableProfiles: string[],
    settings: RuntimeSettings,
    router: AgentRouter,
  ): Promise<MissionTaskInput> {
    // Préférer un arbitre neutre (profil différent de taskA et taskB si possible)
    const neutralProfiles = availableProfiles.filter(
      (p) => p !== debate.taskA.profile && p !== debate.taskB.profile,
    );
    const candidateProfiles = neutralProfiles.length > 0 ? neutralProfiles : availableProfiles;

    const arbiterProfile = await router.bestProfileFor(
      candidateProfiles,
      "Arbitrage contradictoire neutre et résolution de litige",
      candidateProfiles[0] ?? "claude",
    );

    const fallbacks = await router.fallbackOrderFor(
      arbiterProfile,
      availableProfiles,
      "Arbitrage contradictoire neutre",
    );

    const instruction = [
      "Tu es l'arbitre neutre de NEXUS.",
      `Deux agents ont émis des conclusions divergentes sur la mission :`,
      `- Agent A (${debate.taskA.profile}, tâche "${debate.taskA.key}", confiance ${Math.round(debate.taskA.confidence * 100)}%) :`,
      `  "${debate.taskA.summary}"`,
      `- Agent B (${debate.taskB.profile}, tâche "${debate.taskB.key}", confiance ${Math.round(debate.taskB.confidence * 100)}%) :`,
      `  "${debate.taskB.summary}"`,
      "",
      "CONSIGNE D'ARBITRAGE :",
      "1. Analyse rigoureusement les preuves, faits et artefacts fournis par les deux parties.",
      "2. Démêle les contradictions factuelles ou méthodologiques.",
      "3. Identifie les risques non démontrés vs les garanties réelles.",
      "4. Formule un verdict d'arbitrage unifié, clair et exploitable que le synthétiseur final pourra reprendre en toute confiance.",
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
   * Valide et intègre les propositions de sous-tâches émises par un agent dans le DAG d'exécution.
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

    // Filtrer les propositions valides et prioritaires (critical ou recommended)
    const candidates = options.proposals
      .filter((p) => p.priority === "critical" || p.priority === "recommended")
      .filter((p) => !existingKeys.has(p.key))
      .slice(0, maxAdditional);

    if (candidates.length === 0) return options.existingTasks;

    const newTasks: MissionTaskInput[] = [];

    for (const proposal of candidates) {
      // Déterminer le profil (soit spécifié, soit routé automatiquement)
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

      const dependsOn = proposal.depends_on && proposal.depends_on.length > 0
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

    // Réajuster les dépendances de nexus_final_synthesis et nexus_quality_review pour attendre les nouvelles sous-tâches
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
        // Ligne vide
        continue;
      } else if (!trimmed.startsWith(" ") && !trimmed.startsWith("\t")) {
        // Fin de la section de liste
        inSection = false;
      }
    }
  }

  return result;
}

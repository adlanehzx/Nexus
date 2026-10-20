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

describe("AgentCollaborationService (Chantier 14)", () => {
  const service = new AgentCollaborationService();
  const router = new AgentRouter();

  it("extrait fidèlement une sortie structurée en JSON", () => {
    const raw = JSON.stringify({
      summary: "Refactorisation réussie du module d'authentification.",
      payloadType: "code_patch",
      confidenceScore: 0.95,
      assumptions: ["Node 26 LTS utilisé", "Clés JWT 256 bits"],
      openQuestions: ["Faut-il migrer les anciens tokens ?"],
      proposedSubtasks: [
        {
          key: "verify_jwt_migration",
          title: "Vérifier la migration JWT",
          instruction: "Tester la rétrocompatibilité des anciens tokens.",
          reason: "Éviter de déconnecter les sessions existantes.",
          priority: "recommended",
        },
      ],
      artifacts: [
        {
          name: "auth.patch",
          description: "Correctif de signature",
        },
      ],
    });

    const parsed = service.parseTaskOutput(raw);
    expect(parsed.payloadType).toBe("code_patch");
    expect(parsed.confidenceScore).toBe(0.95);
    expect(parsed.assumptions).toEqual(["Node 26 LTS utilisé", "Clés JWT 256 bits"]);
    expect(parsed.proposedSubtasks).toHaveLength(1);
    expect(parsed.proposedSubtasks[0]?.key).toBe("verify_jwt_migration");
  });

  it("extrait sémantiquement les hypothèses et questions depuis du markdown libre", () => {
    const text = `
    J'ai analysé l'architecture du système.
    
    ## Hypothèses
    - PostgreSQL est opérationnel sur localhost:5432
    - Redis n'est pas utilisé pour la persistance durable
    
    ## Questions ouvertes
    - Quelle est la volumétrie cible de requêtes ?
    
    Confiance : 90%
    `;

    const parsed = service.parseTaskOutput(text);
    expect(parsed.confidenceScore).toBe(0.9);
    expect(parsed.assumptions).toContain("PostgreSQL est opérationnel sur localhost:5432");
    expect(parsed.openQuestions).toContain("Quelle est la volumétrie cible de requêtes ?");
  });

  it("formate un contexte amont structuré avec artefacts et indicateurs", () => {
    const context = service.formatStructuredUpstreamContext([
      {
        taskKey: "investigate",
        profileKey: "codex",
        output: {
          summary: "Base de code explorée, aucun composant obsolète.",
          payloadType: "audit_report",
          confidenceScore: 0.92,
          assumptions: ["Version TypeScript 5.8"],
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
            description: "Détail de l'analyse",
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ],
      },
    ]);

    expect(context).toContain("<STRUCTURED_UPSTREAM_CONTEXT>");
    expect(context).toContain("[TASK: investigate | AGENT: codex | TYPE: audit_report | CONFIANCE: 92%]");
    expect(context).toContain("artifact://investigate/report.json");
    expect(context).toContain("Version TypeScript 5.8");
    expect(context).toContain("</STRUCTURED_UPSTREAM_CONTEXT>");
  });

  it("détecte une contradiction formelle et génère une tâche d'arbitrage neutre", async () => {
    const upstream = [
      {
        taskKey: "propose_solution",
        profileKey: "antigravity",
        output: {
          summary: "La solution sans verrouillage est sûre et suffisante.",
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
            "Contradiction majeure : l'absence de verrouillage introduit une race condition critique.",
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
      expect(arbitration.instruction).toContain("arbitre neutre");
      // Préfère codex comme tiers neutre
      expect(arbitration.profile).toBe("codex");
    }
  });

  it("intègre dynamiquement les propositions de sous-tâches prioritaires dans le DAG", async () => {
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
        instruction: "Développe la fonctionnalité",
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
        instruction: "Synthétise",
      },
    ];

    const proposals = [
      {
        key: "benchmark_stress_test",
        title: "Test de charge",
        instruction: "Mesure la latence à 1000 req/s",
        reason: "Vérifier le scaling",
        priority: "critical" as const,
      },
      {
        key: "optional_styling",
        title: "Peaufinage CSS",
        instruction: "Change la couleur",
        reason: "Esthétique",
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

    // Seule la sous-tâche critique doit être intégrée, l'optionnelle est ignorée
    expect(updated).toHaveLength(3);
    const benchmarkTask = updated.find((t) => t.key === "benchmark_stress_test");
    expect(benchmarkTask).toBeDefined();
    expect(benchmarkTask?.depends_on).toEqual(["initial_dev"]);

    // La synthèse finale doit désormais attendre la nouvelle sous-tâche
    const synthesis = updated.find((t) => t.key === "nexus_final_synthesis");
    expect(synthesis?.depends_on).toContain("benchmark_stress_test");
  });
});

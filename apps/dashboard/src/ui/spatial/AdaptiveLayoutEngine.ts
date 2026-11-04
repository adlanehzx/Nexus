/**
 * NEXUS Spatial OS — Adaptive Layout Engine
 * Intelligent layout suggestions & window arrangements based on developer intents.
 */

import type { NativeSpaceId, LayoutPreset } from "./types.js";

export const PRESET_LAYOUTS: Record<string, LayoutPreset> = {
  "code-duo-t3": {
    id: "code-duo-t3",
    name: "T3 Duo Agents & Worktrees",
    description: "Claude 3.7 Sonnet (gauche) + Codex/Cursor (droite) + Worktrees Git & Runs (bas)",
    spaceId: "code",
    windows: [
      {
        id: "code-claude-1",
        title: "Agent Claude 3.7 Sonnet (T3)",
        spaceId: "code",
        type: "chat",
        x: 40,
        y: 40,
        width: 680,
        height: 480,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
        metadata: { provider: "claude", role: "Frontend & Architecture" },
      },
      {
        id: "code-codex-1",
        title: "Agent Cursor / Codex (T3)",
        spaceId: "code",
        type: "chat",
        x: 740,
        y: 40,
        width: 680,
        height: 480,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
        metadata: { provider: "cursor", role: "Backend & Systems" },
      },
      {
        id: "code-vcs-1",
        title: "VCS & Worktrees Git Isolés",
        spaceId: "code",
        type: "vcs-worktrees",
        x: 40,
        y: 540,
        width: 820,
        height: 350,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
      {
        id: "code-runs-1",
        title: "Exécutions d'agents & Tests",
        spaceId: "code",
        type: "runs",
        x: 880,
        y: 540,
        width: 540,
        height: 350,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
    ],
  },
  "mission-dag-full": {
    id: "mission-dag-full",
    name: "Mission Control & Débogueur DAG",
    description: "Graphe DAG temps réel + Contrôle de mission ACP + Journaux d'exécution",
    spaceId: "mission",
    windows: [
      {
        id: "msn-dag-1",
        title: "Débogueur de Graphe DAG",
        spaceId: "mission",
        type: "dag-debugger",
        x: 40,
        y: 40,
        width: 860,
        height: 740,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
      {
        id: "msn-ctrl-1",
        title: "Missions ACP en cours",
        spaceId: "mission",
        type: "mission-control",
        x: 920,
        y: 40,
        width: 560,
        height: 420,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
      {
        id: "msn-logs-1",
        title: "Journaux d'Orchestration",
        spaceId: "mission",
        type: "logs",
        x: 920,
        y: 480,
        width: 560,
        height: 300,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
    ],
  },
  "device-topology": {
    id: "device-topology",
    name: "Topologie des Machines & Workers",
    description: "Mesh d'appareils connectés, pool de workers et supervision du browser worker",
    spaceId: "device",
    windows: [
      {
        id: "dev-mesh-1",
        title: "Topologie des Appareils",
        spaceId: "device",
        type: "devices",
        x: 40,
        y: 40,
        width: 760,
        height: 720,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
      {
        id: "dev-workers-1",
        title: "Pool de Workers Distribués",
        spaceId: "device",
        type: "workers",
        x: 820,
        y: 40,
        width: 620,
        height: 340,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
      {
        id: "dev-browser-1",
        title: "Browser Worker & Visual Control",
        spaceId: "device",
        type: "browser",
        x: 820,
        y: 400,
        width: 620,
        height: 360,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
    ],
  },
  "memory-graph": {
    id: "memory-graph",
    name: "Explorateur de Mémoire Sémantique",
    description: "Vector search, graphe de communication et politiques de sécurité",
    spaceId: "memory",
    windows: [
      {
        id: "mem-search-1",
        title: "Explorateur de Mémoire Sémantique",
        spaceId: "memory",
        type: "memory",
        x: 40,
        y: 40,
        width: 820,
        height: 720,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
      {
        id: "mem-graph-1",
        title: "Graphe de Communication & Provenance",
        spaceId: "memory",
        type: "communication-graph",
        x: 880,
        y: 40,
        width: 580,
        height: 400,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
      {
        id: "mem-sec-1",
        title: "Sécurité & Garde-fous",
        spaceId: "memory",
        type: "security",
        x: 880,
        y: 460,
        width: 580,
        height: 300,
        isMinimized: false,
        isMaximized: false,
        isFloating: false,
        isPinned: false,
      },
    ],
  },
};

export interface AssistRecommendation {
  spaceId: NativeSpaceId;
  title: string;
  description: string;
  presetId?: string;
  actionText: string;
}

export function analyzeIntentForAssistLayout(intent: string): AssistRecommendation | null {
  const lower = intent.toLowerCase().trim();
  if (!lower) return null;

  if (
    lower.includes("code") ||
    lower.includes("dev") ||
    lower.includes("git") ||
    lower.includes("worktree") ||
    lower.includes("diff") ||
    lower.includes("claude") ||
    lower.includes("codex") ||
    lower.includes("branch") ||
    lower.includes("pr")
  ) {
    return {
      spaceId: "code",
      title: "Disposition suggérée : Espace de Développement T3 Code",
      description:
        "Organisation en double agent (Claude + Codex) avec VCS Worktrees et exécutions de tests.",
      presetId: "code-duo-t3",
      actionText: "Appliquer la disposition Code",
    };
  }

  if (
    lower.includes("mission") ||
    lower.includes("dag") ||
    lower.includes("orchestr") ||
    lower.includes("tache") ||
    lower.includes("pipeline") ||
    lower.includes("supervis")
  ) {
    return {
      spaceId: "mission",
      title: "Disposition suggérée : Mission Control & DAG Debugger",
      description:
        "Centrage sur le graphe DAG interactif, les contrôles ACP et les logs d'exécution.",
      presetId: "mission-dag-full",
      actionText: "Appliquer la disposition Mission",
    };
  }

  if (
    lower.includes("device") ||
    lower.includes("machine") ||
    lower.includes("worker") ||
    lower.includes("android") ||
    lower.includes("linux") ||
    lower.includes("browser")
  ) {
    return {
      spaceId: "device",
      title: "Disposition suggérée : Topologie Matérielle & Workers",
      description: "Vue spatiale des machines connectées, du pool de workers et du browser worker.",
      presetId: "device-topology",
      actionText: "Appliquer la disposition Device",
    };
  }

  if (
    lower.includes("memoire") ||
    lower.includes("memory") ||
    lower.includes("souvenir") ||
    lower.includes("graphe") ||
    lower.includes("semantique") ||
    lower.includes("vector")
  ) {
    return {
      spaceId: "memory",
      title: "Disposition suggérée : Exploration de Mémoire Sémantique",
      description: "Accès vectoriel aux souvenirs, graphe de communication et sécurité.",
      presetId: "memory-graph",
      actionText: "Appliquer la disposition Memory",
    };
  }

  return null;
}

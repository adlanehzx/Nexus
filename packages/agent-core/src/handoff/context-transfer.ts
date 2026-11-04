/**
 * NEXUS Context Transfer & Cross-Provider Handoff Service (LOT E)
 *
 * Implements seamless provider switching without loss of history,
 * preserving provenance, Git checkpoints, tool executions and artifacts.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProviderType } from "@nexus/protocol";
import type { LlmMessage } from "@nexus/llm";

export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "completed" | "failed" | "rejected";
}

export interface CanonicalTurn {
  turnNumber: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  providerOrigin: ProviderType;
  toolCalls?: CanonicalToolCall[];
  timestamp: string;
}

export interface CanonicalArtifact {
  path: string;
  summary: string;
  hash: string;
}

export interface GitCheckpointReference {
  commitHash: string;
  branch: string;
  diffBlob?: string;
  worktreePath: string;
}

export interface CanonicalHandoffContext {
  threadId: string;
  originProvider: ProviderType;
  originModel: string;
  targetProvider: ProviderType;
  targetModel: string;
  systemPrompt: string;
  gitCheckpoint?: GitCheckpointReference;
  turns: CanonicalTurn[];
  artifacts: CanonicalArtifact[];
  shortTermMemory: Record<string, string>;
}

export interface AdaptedContextResult {
  systemPrompt: string;
  messages: LlmMessage[];
  totalTokensEstimated: number;
  truncatedTurnCount: number;
  preservedProvenance: {
    turnCount: number;
    providerCounts: Record<string, number>;
  };
}

export class ContextTransferService {
  /**
   * Adapts canonical context to target provider requirements and context constraints.
   */
  adaptForTarget(
    canonical: CanonicalHandoffContext,
    targetContextWindowTokens: number,
  ): AdaptedContextResult {
    // 1. Build immutable preamble (System prompt + Git checkpoint + Active artifacts + Short term memory)
    let preamble = canonical.systemPrompt;

    if (canonical.gitCheckpoint) {
      preamble += `\n\n# Codebase Workspace State\n- Branch: ${canonical.gitCheckpoint.branch}\n- Checkpoint Commit: ${canonical.gitCheckpoint.commitHash}\n- Working Tree: ${canonical.gitCheckpoint.worktreePath}`;
    }

    if (canonical.artifacts.length > 0) {
      const artifactList = canonical.artifacts
        .map((a) => `- [${a.path}]: ${a.summary} (sha256: ${a.hash.slice(0, 8)})`)
        .join("\n");
      preamble += `\n\n# Produced Artifacts\n${artifactList}`;
    }

    if (Object.keys(canonical.shortTermMemory).length > 0) {
      const memories = Object.entries(canonical.shortTermMemory)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n");
      preamble += `\n\n# Key Decisions & Established Facts\n${memories}`;
    }

    preamble += `\n\n# Execution Handoff\n- Transferred from: ${canonical.originProvider} (${canonical.originModel})\n- Active Provider: ${canonical.targetProvider} (${canonical.targetModel})`;

    // Simple rough token estimation (~4 chars per token)
    const preambleTokens = Math.ceil(preamble.length / 4);
    const tokenBudgetForTurns = Math.max(1000, targetContextWindowTokens - preambleTokens - 2000);

    // 2. Select turns respecting budget: Always preserve initial prompt, then as many recent turns as fit
    const turns = [...canonical.turns];
    const providerCounts: Record<string, number> = {};
    for (const t of turns) {
      providerCounts[t.providerOrigin] = (providerCounts[t.providerOrigin] ?? 0) + 1;
    }

    let keptTurns: CanonicalTurn[] = [];
    let truncatedCount = 0;

    if (turns.length > 0) {
      const firstTurn = turns[0]!;
      const remaining = turns.slice(1);

      let currentTokenEstimate = Math.ceil(firstTurn.content.length / 4);
      const recentBuffer: CanonicalTurn[] = [];

      // Iterate backwards from most recent turn
      for (let i = remaining.length - 1; i >= 0; i--) {
        const turn = remaining[i]!;
        const turnTokens = Math.ceil(turn.content.length / 4);
        if (currentTokenEstimate + turnTokens <= tokenBudgetForTurns) {
          recentBuffer.unshift(turn);
          currentTokenEstimate += turnTokens;
        } else {
          truncatedCount = i + 1;
          break;
        }
      }

      keptTurns = [firstTurn, ...recentBuffer];
    }

    // 3. Transform to standard LlmMessage format with provenance annotation
    let totalTurnChars = 0;
    const messages: LlmMessage[] = keptTurns.map((turn) => {
      const provenancePrefix = `[Turn ${turn.turnNumber} via ${turn.providerOrigin}] `;
      const text =
        turn.role === "assistant" ? `${provenancePrefix}${turn.content}` : turn.content;
      totalTurnChars += text.length;

      const role: "user" | "assistant" | "system" =
        turn.role === "tool" ? "user" : turn.role;

      return {
        role,
        content: [{ type: "text" as const, text }],
      };
    });

    const totalTokensEstimated = preambleTokens + Math.ceil(totalTurnChars / 4);

    return {
      systemPrompt: preamble,
      messages,
      totalTokensEstimated,
      truncatedTurnCount: truncatedCount,
      preservedProvenance: {
        turnCount: keptTurns.length,
        providerCounts,
      },
    };
  }
}

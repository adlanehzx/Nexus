/**
 * NEXUS Transactional Orchestration - Deterministic Mission Projection
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { MissionEvent } from "./events.js";

export type MissionPhase =
  | "created"
  | "planned"
  | "running"
  | "waiting_for_confirmation"
  | "completed"
  | "cancelled"
  | "failed";

export interface ProjectedToolExecution {
  toolCallId: string;
  toolName: string;
  status: "pending" | "confirmed" | "rejected" | "completed" | "failed";
  durationMs?: number;
  result?: unknown;
  error?: string;
}

export interface ProjectedMissionState {
  missionId: string;
  version: number;
  phase: MissionPhase;
  plan?: {
    goal: string;
    steps: { id: string; title: string; status: "pending" | "running" | "completed" | "failed" }[];
  };
  tools: ProjectedToolExecution[];
  pendingConfirmation?: {
    confirmationId: string;
    callId: string;
    toolName: string;
    arguments: unknown;
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  finalOutput?: string;
  correlationId: string;
}

/**
 * Deterministically reconstructs the state of a mission from its event stream.
 * Pure function: identical event sequences always produce identical states.
 */
export function projectMission(events: MissionEvent[]): ProjectedMissionState | null {
  if (events.length === 0) return null;

  // Sort events strictly by monotonically increasing version
  const sorted = [...events].sort((a, b) => a.version - b.version);

  const first = sorted[0]!;
  const state: ProjectedMissionState = {
    missionId: first.missionId,
    version: first.version,
    phase: "created",
    tools: [],
    createdAt: first.timestamp,
    correlationId: first.correlationId,
  };

  for (const ev of sorted) {
    state.version = ev.version;
    const payload = ev.payload as Record<string, any>;

    switch (ev.type) {
      case "mission.created":
        state.phase = "created";
        break;

      case "mission.planned":
        state.phase = "planned";
        if (payload.plan) {
          state.plan = payload.plan;
        }
        break;

      case "mission.started":
      case "mission.resumed":
        state.phase = "running";
        if (!state.startedAt) state.startedAt = ev.timestamp;
        state.pendingConfirmation = undefined;
        break;

      case "mission.step_started":
        if (state.plan && payload.stepId) {
          const step = state.plan.steps.find((s) => s.id === payload.stepId);
          if (step) step.status = "running";
        }
        break;

      case "mission.step_completed":
        if (state.plan && payload.stepId) {
          const step = state.plan.steps.find((s) => s.id === payload.stepId);
          if (step) step.status = payload.success ? "completed" : "failed";
        }
        break;

      case "mission.waiting_confirmation":
        state.phase = "waiting_for_confirmation";
        state.pendingConfirmation = {
          confirmationId: payload.confirmationId ?? ev.id,
          callId: payload.callId,
          toolName: payload.toolName,
          arguments: payload.arguments,
        };
        break;

      case "mission.confirmation_resolved":
        if (state.pendingConfirmation) {
          const tool = state.tools.find((t) => t.toolCallId === state.pendingConfirmation?.callId);
          if (tool) {
            tool.status = payload.approved ? "confirmed" : "rejected";
          }
          state.pendingConfirmation = undefined;
        }
        break;

      case "tool.execution_requested":
        state.tools.push({
          toolCallId: payload.toolCallId ?? ev.id,
          toolName: payload.toolName,
          status: "pending",
        });
        break;

      case "tool.execution_completed": {
        const tool = state.tools.find((t) => t.toolCallId === payload.toolCallId);
        if (tool) {
          tool.status = "completed";
          tool.durationMs = payload.durationMs;
          tool.result = payload.result;
        }
        break;
      }

      case "tool.execution_failed": {
        const tool = state.tools.find((t) => t.toolCallId === payload.toolCallId);
        if (tool) {
          tool.status = "failed";
          tool.error = payload.error;
        }
        break;
      }

      case "mission.completed":
        state.phase = "completed";
        state.completedAt = ev.timestamp;
        state.finalOutput = payload.output;
        break;

      case "mission.cancelled":
        state.phase = "cancelled";
        state.completedAt = ev.timestamp;
        state.failureReason = payload.reason ?? "Cancelled by user";
        break;

      case "mission.failed":
        state.phase = "failed";
        state.completedAt = ev.timestamp;
        state.failureReason = payload.error ?? "Internal execution failure";
        break;
    }
  }

  return state;
}

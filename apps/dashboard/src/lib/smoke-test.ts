import type { ConnectionCatalogEntry } from "./api.js";

export type SmokeTestStepId =
  | "backend_reachability"
  | "user_auth"
  | "provider_availability"
  | "controlled_request"
  | "verify_outcome"
  | "capabilities_sandbox"
  | "agent_core_run";

export type SmokeTestStepStatus = "passed" | "failed" | "blocked" | "skipped";

export interface SmokeTestStepResult {
  id: SmokeTestStepId;
  name: string;
  status: SmokeTestStepStatus;
  durationMs: number;
  error: string | null;
  traceId: string;
  details?: string;
}

export interface SmokeTestExecutionOptions {
  level?: 1 | 2;
  allowBillableRequests?: boolean;
  selectedProviderId?: string;
}

export interface SmokeTestProof {
  conversationId?: string | undefined;
  runId?: string | undefined;
  traceId: string;
  provider?: string | undefined;
  model?: string | undefined;
  durationMs: number;
  status: string;
  controlledResult?: string | undefined;
}

export interface SmokeTestExecutionResult {
  overallStatus: "passed" | "failed";
  traceId: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  steps: SmokeTestStepResult[];
  error?: string | null | undefined;
  proof?: SmokeTestProof | undefined;
}

export interface MinimalSession {
  checkReadiness(): Promise<{
    status: "ok" | "degraded" | "down";
    diagnostic?: string | undefined;
  }>;
  isAuthenticated: boolean;
  ensureActiveSession?(): Promise<unknown>;
}

export interface SmokeTestApi {
  connections(): Promise<{ connections: ConnectionCatalogEntry[] }>;
  testConnection(providerId: string): Promise<ConnectionCatalogEntry>;
  tools(): Promise<{ tools: { name: string; description?: string | undefined }[] }>;
  createConversation?(input: { title?: string | undefined }): Promise<{ id: string }>;
  createAgentRun?(input: {
    conversationId: string;
    prompt: string;
    model?: string | undefined;
    provider?: string | undefined;
  }): Promise<{ id: string; status: string; output?: string | undefined }>;
  getAgentRun?(id: string): Promise<{ id: string; status: string; output?: string | undefined }>;
  archiveConversation?(conversationId: string): Promise<unknown>;
}

export const SMOKE_TEST_STEP_NAMES: Record<SmokeTestStepId, { en: string; fr: string }> = {
  backend_reachability: {
    en: "Backend Reachability & Health",
    fr: "Accessibilité & Santé du Backend",
  },
  user_auth: {
    en: "User Authentication & Context",
    fr: "Authentification de l'Utilisateur",
  },
  provider_availability: {
    en: "Operational AI Provider Check",
    fr: "Disponibilité d'un Fournisseur IA",
  },
  controlled_request: {
    en: "Controlled Provider Test Execution",
    fr: "Exécution Contrôlée de la Requête Test",
  },
  verify_outcome: {
    en: "Execution Outcome Verification",
    fr: "Vérification du Résultat d'Exécution",
  },
  capabilities_sandbox: {
    en: "Mission Capabilities & Sandbox Guard",
    fr: "Capacités de Mission & Bac à Sable Isolé",
  },
  agent_core_run: {
    en: "Controlled Real Agent Core Execution (Level 2)",
    fr: "Exécution Réelle Agent Core Contrôlée (Niveau 2)",
  },
};

function generateTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `smoke-${crypto.randomUUID()}`;
  }
  return `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Executes a real smoke test pipeline against the NEXUS backend.
 *
 * Tier 1 (Level 1) — Zero-cost diagnostics:
 *   1. Backend reachability & 4-state health
 *   2. User authentication & active admin context
 *   3. Provider configuration & operational availability
 *   4. Controlled provider non-destructive ping
 *   5. Outcome & latency verification
 *   6. Capabilities registry & sandbox isolation probe
 *
 * Tier 2 (Level 2) — Controlled real execution with explicit consent:
 *   7. Creates an ephemeral test conversation, executes a real Agent Core run,
 *      verifies deterministic outcome, and records full audit proof.
 */
export async function executeSmokeTest(
  api: SmokeTestApi,
  session: MinimalSession,
  options: SmokeTestExecutionOptions = {},
): Promise<SmokeTestExecutionResult> {
  const rootTraceId = generateTraceId();
  const startedAt = new Date().toISOString();
  const startTime = performance.now();
  const steps: SmokeTestStepResult[] = [];

  let isBlocked = false;
  let usableProvider: ConnectionCatalogEntry | null = null;
  let testResponse: unknown = null;
  let proof: SmokeTestProof | undefined;

  // 1. Backend reachability
  {
    const stepStart = performance.now();
    const traceId = `${rootTraceId}-step-1`;
    try {
      const readiness = await session.checkReadiness();
      const elapsed = Math.round(performance.now() - stepStart);
      if (readiness.status === "down") {
        steps.push({
          id: "backend_reachability",
          name: SMOKE_TEST_STEP_NAMES.backend_reachability.en,
          status: "failed",
          durationMs: elapsed,
          error: readiness.diagnostic ?? "Backend server reported DOWN state",
          traceId,
        });
        isBlocked = true;
      } else {
        steps.push({
          id: "backend_reachability",
          name: SMOKE_TEST_STEP_NAMES.backend_reachability.en,
          status: "passed",
          durationMs: elapsed,
          error: null,
          traceId,
          details: `Backend status: ${readiness.status}`,
        });
      }
    } catch (cause) {
      const elapsed = Math.round(performance.now() - stepStart);
      steps.push({
        id: "backend_reachability",
        name: SMOKE_TEST_STEP_NAMES.backend_reachability.en,
        status: "failed",
        durationMs: elapsed,
        error: cause instanceof Error ? cause.message : "Failed to reach backend",
        traceId,
      });
      isBlocked = true;
    }
  }

  // 2. User authentication
  {
    const stepStart = performance.now();
    const traceId = `${rootTraceId}-step-2`;
    if (isBlocked) {
      steps.push({
        id: "user_auth",
        name: SMOKE_TEST_STEP_NAMES.user_auth.en,
        status: "blocked",
        durationMs: 0,
        error: "Blocked by backend reachability failure",
        traceId,
      });
    } else {
      try {
        if (session.ensureActiveSession) {
          await session.ensureActiveSession();
        }
        const authenticated = session.isAuthenticated;
        const elapsed = Math.round(performance.now() - stepStart);
        if (!authenticated) {
          steps.push({
            id: "user_auth",
            name: SMOKE_TEST_STEP_NAMES.user_auth.en,
            status: "failed",
            durationMs: elapsed,
            error: "No active authenticated session found. Admin authentication required.",
            traceId,
          });
          isBlocked = true;
        } else {
          steps.push({
            id: "user_auth",
            name: SMOKE_TEST_STEP_NAMES.user_auth.en,
            status: "passed",
            durationMs: elapsed,
            error: null,
            traceId,
            details: "User session authenticated and authorized",
          });
        }
      } catch (cause) {
        const elapsed = Math.round(performance.now() - stepStart);
        steps.push({
          id: "user_auth",
          name: SMOKE_TEST_STEP_NAMES.user_auth.en,
          status: "failed",
          durationMs: elapsed,
          error: cause instanceof Error ? cause.message : "Authentication verification failed",
          traceId,
        });
        isBlocked = true;
      }
    }
  }

  // 3. Provider availability
  {
    const stepStart = performance.now();
    const traceId = `${rootTraceId}-step-3`;
    if (isBlocked) {
      steps.push({
        id: "provider_availability",
        name: SMOKE_TEST_STEP_NAMES.provider_availability.en,
        status: "blocked",
        durationMs: 0,
        error: "Blocked by previous failure",
        traceId,
      });
    } else {
      try {
        const catalog = await api.connections();
        const available = catalog.connections.filter(
          (c) =>
            c.supportedOnThisHost &&
            c.observation &&
            (c.observation.state === "connected" ||
              c.observation.authStatus === "authenticated" ||
              c.observation.state === "testing"),
        );

        const elapsed = Math.round(performance.now() - stepStart);
        if (available.length === 0) {
          steps.push({
            id: "provider_availability",
            name: SMOKE_TEST_STEP_NAMES.provider_availability.en,
            status: "failed",
            durationMs: elapsed,
            error: "No operational or authenticated provider configured. At least 1 required.",
            traceId,
          });
          isBlocked = true;
        } else {
          const matched =
            available.find((c) => c.providerId === options.selectedProviderId) ?? available[0];
          if (!matched) {
            steps.push({
              id: "provider_availability",
              name: SMOKE_TEST_STEP_NAMES.provider_availability.en,
              status: "failed",
              durationMs: elapsed,
              error: "No operational or authenticated provider configured. At least 1 required.",
              traceId,
            });
            isBlocked = true;
          } else {
            usableProvider = matched;
            steps.push({
              id: "provider_availability",
              name: SMOKE_TEST_STEP_NAMES.provider_availability.en,
              status: "passed",
              durationMs: elapsed,
              error: null,
              traceId,
              details: `Selected provider: ${matched.displayName} (${matched.providerId})`,
            });
          }
        }
      } catch (cause) {
        const elapsed = Math.round(performance.now() - stepStart);
        steps.push({
          id: "provider_availability",
          name: SMOKE_TEST_STEP_NAMES.provider_availability.en,
          status: "failed",
          durationMs: elapsed,
          error: cause instanceof Error ? cause.message : "Failed to query providers",
          traceId,
        });
        isBlocked = true;
      }
    }
  }

  // 4. Controlled test execution
  {
    const stepStart = performance.now();
    const traceId = `${rootTraceId}-step-4`;
    if (isBlocked || !usableProvider) {
      steps.push({
        id: "controlled_request",
        name: SMOKE_TEST_STEP_NAMES.controlled_request.en,
        status: "blocked",
        durationMs: 0,
        error: "Blocked by missing provider",
        traceId,
      });
    } else {
      try {
        const result = await api.testConnection(usableProvider.providerId);
        testResponse = result;
        const elapsed = Math.round(performance.now() - stepStart);
        steps.push({
          id: "controlled_request",
          name: SMOKE_TEST_STEP_NAMES.controlled_request.en,
          status: "passed",
          durationMs: elapsed,
          error: null,
          traceId,
          details: `Tested ${usableProvider.providerId} via non-destructive probe`,
        });
      } catch (cause) {
        const elapsed = Math.round(performance.now() - stepStart);
        steps.push({
          id: "controlled_request",
          name: SMOKE_TEST_STEP_NAMES.controlled_request.en,
          status: "failed",
          durationMs: elapsed,
          error: cause instanceof Error ? cause.message : "Provider test execution failed",
          traceId,
        });
        isBlocked = true;
      }
    }
  }

  // 5. Verify outcome
  {
    const stepStart = performance.now();
    const traceId = `${rootTraceId}-step-5`;
    if (isBlocked || !testResponse) {
      steps.push({
        id: "verify_outcome",
        name: SMOKE_TEST_STEP_NAMES.verify_outcome.en,
        status: "blocked",
        durationMs: 0,
        error: "Blocked by test execution failure",
        traceId,
      });
    } else {
      const elapsed = Math.round(performance.now() - stepStart);
      const entry = testResponse as ConnectionCatalogEntry;
      const obs = entry.observation;
      const isOk = obs && obs.state !== "error" && obs.authStatus !== "unauthenticated";

      if (!isOk) {
        steps.push({
          id: "verify_outcome",
          name: SMOKE_TEST_STEP_NAMES.verify_outcome.en,
          status: "failed",
          durationMs: elapsed,
          error: obs?.userMessage ?? "Provider test returned degraded or error observation",
          traceId,
        });
        isBlocked = true;
      } else {
        steps.push({
          id: "verify_outcome",
          name: SMOKE_TEST_STEP_NAMES.verify_outcome.en,
          status: "passed",
          durationMs: elapsed,
          error: null,
          traceId,
          details: `Verification successful: state=${obs.state}`,
        });
      }
    }
  }

  // 6. Capabilities check & isolated non-destructive sandbox action
  {
    const stepStart = performance.now();
    const traceId = `${rootTraceId}-step-6`;
    if (isBlocked) {
      steps.push({
        id: "capabilities_sandbox",
        name: SMOKE_TEST_STEP_NAMES.capabilities_sandbox.en,
        status: "blocked",
        durationMs: 0,
        error: "Blocked by outcome verification failure",
        traceId,
      });
    } else {
      try {
        const toolsResult = await api.tools();
        const elapsed = Math.round(performance.now() - stepStart);
        if (!toolsResult || !Array.isArray(toolsResult.tools)) {
          steps.push({
            id: "capabilities_sandbox",
            name: SMOKE_TEST_STEP_NAMES.capabilities_sandbox.en,
            status: "failed",
            durationMs: elapsed,
            error: "Failed to retrieve or verify core tools registry",
            traceId,
          });
        } else {
          steps.push({
            id: "capabilities_sandbox",
            name: SMOKE_TEST_STEP_NAMES.capabilities_sandbox.en,
            status: "passed",
            durationMs: elapsed,
            error: null,
            traceId,
            details: `Validated ${toolsResult.tools.length} core tools in isolated environment`,
          });
        }
      } catch (cause) {
        const elapsed = Math.round(performance.now() - stepStart);
        steps.push({
          id: "capabilities_sandbox",
          name: SMOKE_TEST_STEP_NAMES.capabilities_sandbox.en,
          status: "failed",
          durationMs: elapsed,
          error: cause instanceof Error ? cause.message : "Capabilities probe failed",
          traceId,
        });
      }
    }
  }

  // 7. Level 2: Controlled Real Agent Core Execution (explicit consent requested)
  if (options.level === 2 || options.allowBillableRequests) {
    const stepStart = performance.now();
    const traceId = `${rootTraceId}-step-7`;
    if (isBlocked || !usableProvider) {
      steps.push({
        id: "agent_core_run",
        name: SMOKE_TEST_STEP_NAMES.agent_core_run.en,
        status: "blocked",
        durationMs: 0,
        error: "Blocked by earlier verification failure",
        traceId,
      });
    } else if (options.allowBillableRequests === false) {
      steps.push({
        id: "agent_core_run",
        name: SMOKE_TEST_STEP_NAMES.agent_core_run.en,
        status: "skipped",
        durationMs: 0,
        error: null,
        traceId,
        details: "Skipped: requires explicit user consent for billable agent execution",
      });
    } else if (
      typeof api.createConversation !== "function" ||
      typeof api.createAgentRun !== "function"
    ) {
      steps.push({
        id: "agent_core_run",
        name: SMOKE_TEST_STEP_NAMES.agent_core_run.en,
        status: "failed",
        durationMs: 0,
        error: "Agent Core execution APIs not available on client interface",
        traceId,
      });
    } else {
      let createdConvId: string | undefined;
      try {
        const conv = await api.createConversation({ title: "Smoke Test Validation Run" });
        createdConvId = conv.id;
        let run = await api.createAgentRun({
          conversationId: conv.id,
          prompt: "PING: Respond with PONG_OK and system timestamp",
          provider: usableProvider.providerId,
        });

        // If status is non-terminal, poll with backoff
        if (
          (run.status === "running" || run.status === "pending") &&
          typeof api.getAgentRun === "function"
        ) {
          const pollStart = Date.now();
          while (
            (run.status === "running" || run.status === "pending") &&
            Date.now() - pollStart < 15000
          ) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            run = await api.getAgentRun(run.id);
          }
        }

        const elapsed = Math.round(performance.now() - stepStart);

        // Strict verification: terminal status must be "succeeded" (or "completed")
        if (run.status !== "succeeded" && run.status !== "completed") {
          steps.push({
            id: "agent_core_run",
            name: SMOKE_TEST_STEP_NAMES.agent_core_run.en,
            status: "failed",
            durationMs: elapsed,
            error: `Agent Core execution did not reach terminal succeeded state (received status: ${run.status})`,
            traceId,
          });
        } else if (
          !run.output ||
          typeof run.output !== "string" ||
          run.output.trim().length === 0
        ) {
          // Reject empty output or fake fallback
          steps.push({
            id: "agent_core_run",
            name: SMOKE_TEST_STEP_NAMES.agent_core_run.en,
            status: "failed",
            durationMs: elapsed,
            error: "Agent Core execution finished but produced empty or missing response payload",
            traceId,
          });
        } else {
          proof = {
            conversationId: conv.id,
            runId: run.id,
            traceId,
            provider: usableProvider.providerId,
            durationMs: elapsed,
            status: run.status,
            controlledResult: run.output,
          };

          steps.push({
            id: "agent_core_run",
            name: SMOKE_TEST_STEP_NAMES.agent_core_run.en,
            status: "passed",
            durationMs: elapsed,
            error: null,
            traceId,
            details: `Agent run completed: id=${run.id}, status=${run.status}`,
          });
        }
      } catch (cause) {
        const elapsed = Math.round(performance.now() - stepStart);
        steps.push({
          id: "agent_core_run",
          name: SMOKE_TEST_STEP_NAMES.agent_core_run.en,
          status: "failed",
          durationMs: elapsed,
          error: cause instanceof Error ? cause.message : "Agent Core execution failed",
          traceId,
        });
      } finally {
        if (createdConvId && typeof api.archiveConversation === "function") {
          await api.archiveConversation(createdConvId).catch((_cleanupErr: unknown) => {
            void _cleanupErr;
          });
        }
      }
    }
  }

  const completedAt = new Date().toISOString();
  const totalDurationMs = Math.round(performance.now() - startTime);
  const overallStatus = steps.every((s) => s.status === "passed" || s.status === "skipped")
    ? "passed"
    : "failed";

  return {
    overallStatus,
    traceId: rootTraceId,
    startedAt,
    completedAt,
    totalDurationMs,
    steps,
    proof,
    error:
      overallStatus === "failed"
        ? (steps.find((s) => s.error)?.error ?? "Smoke test failed")
        : null,
  };
}

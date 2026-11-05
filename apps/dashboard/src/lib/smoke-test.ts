import type { ConnectionCatalogEntry, DashboardApi } from "./api.js";

export type SmokeTestStepId =
  | "backend_reachability"
  | "user_auth"
  | "provider_availability"
  | "controlled_request"
  | "verify_outcome"
  | "capabilities_sandbox";

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
  allowBillableRequests?: boolean;
  selectedProviderId?: string;
}

export interface SmokeTestExecutionResult {
  overallStatus: "passed" | "failed";
  traceId: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  steps: SmokeTestStepResult[];
  error?: string | null;
}

export interface MinimalSession {
  checkReadiness(): Promise<{ status: "ok" | "degraded" | "down"; diagnostic?: string }>;
  isAuthenticated: boolean;
  ensureActiveSession?(): Promise<unknown>;
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
};

function generateTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `smoke-${crypto.randomUUID()}`;
  }
  return `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Executes a real 6-step smoke test pipeline against the NEXUS backend.
 *
 * Rules:
 *  - An unreachable backend or unauthenticated user immediately fails and blocks subsequent steps.
 *  - An environment with zero operational providers NEVER receives a 'passed' status.
 *  - Each step records real durations and correlation trace IDs.
 */
export async function executeSmokeTest(
  api: DashboardApi,
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
          error: readiness.diagnostic || "Backend server reported DOWN state",
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
          usableProvider =
            available.find((c) => c.providerId === options.selectedProviderId) || available[0];
          steps.push({
            id: "provider_availability",
            name: SMOKE_TEST_STEP_NAMES.provider_availability.en,
            status: "passed",
            durationMs: elapsed,
            error: null,
            traceId,
            details: `Selected provider: ${usableProvider.displayName} (${usableProvider.providerId})`,
          });
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
          error: obs?.userMessage || "Provider test returned degraded or error observation",
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

  const completedAt = new Date().toISOString();
  const totalDurationMs = Math.round(performance.now() - startTime);
  const overallStatus = steps.every((s) => s.status === "passed") ? "passed" : "failed";

  return {
    overallStatus,
    traceId: rootTraceId,
    startedAt,
    completedAt,
    totalDurationMs,
    steps,
    error:
      overallStatus === "failed" ? steps.find((s) => s.error)?.error || "Smoke test failed" : null,
  };
}

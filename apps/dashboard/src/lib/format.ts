import type { ActivityEntry, HealthEntry, TaskRow, WorkerRow } from "./api.js";

/**
 * Core presentation logic for the dashboard.
 *
 * A monitoring screen must make definitive decisions: what does the status bar
 * look like when a worker is disconnected and an MCP server has never been connected?
 * These decisions are resolved here and covered by automated tests.
 *
 * Presentation components stay strictly declarative.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

export type OverallHealth = "ok" | "degraded" | "down" | "unknown";

/**
 * Computes overall health from subsystem status entries.
 *
 * Two rules:
 *  1. **Worst state wins.** A system with a down component is not "partially online".
 *  2. **Unconfigured components do not count as failures.** Never having connected
 *     an MCP server is not an incident. If only unconfigured components exist,
 *     the status is `unknown`.
 */
export function overallHealth(entries: readonly HealthEntry[]): OverallHealth {
  const measured = entries.filter((entry) => entry.level !== "unconfigured");
  if (measured.length === 0) return "unknown";

  if (measured.some((entry) => entry.level === "down")) return "down";
  if (measured.some((entry) => entry.level === "degraded")) return "degraded";
  return "ok";
}

export const HEALTH_LABELS: Record<HealthEntry["level"], string> = {
  ok: "operational",
  degraded: "degraded",
  down: "down",
  unconfigured: "unconfigured",
};

// ─────────────────────────────────────────────────────────────────────────────
// Connection Classification (7 core states)
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionStatusKey =
  | "not_installed"
  | "detected"
  | "missing_adapter"
  | "connection_required"
  | "connected"
  | "degraded"
  | "failed";

export interface ConnectionStatusBadge {
  key: ConnectionStatusKey;
  label: string;
  tone: "good" | "warning" | "danger" | "muted";
  description: string;
}

/**
 * Classifies an agent connection into one of the 7 required distinct states:
 *  - not installed
 *  - detected
 *  - missing adapter
 *  - connection required
 *  - connected
 *  - degraded
 *  - failed
 */
export function classifyConnection(entry: {
  supportedOnThisHost?: boolean;
  adapter?: { availability?: string; provenance?: string; provenanceEvidence?: string } | null;
  observation?: {
    state: string;
    authStatus?: string;
    adapter?: { availability?: string } | null;
  } | null;
}): ConnectionStatusBadge {
  if (entry.supportedOnThisHost === false) {
    return {
      key: "not_installed",
      label: "Unsupported host",
      tone: "muted",
      description: "Provider is not supported on this host platform.",
    };
  }

  const observation = entry.observation;
  if (!observation) {
    return {
      key: "not_installed",
      label: "Not installed",
      tone: "muted",
      description: "Provider has not been detected or verified.",
    };
  }

  if (observation.state === "not_installed") {
    return {
      key: "not_installed",
      label: "Not installed",
      tone: "muted",
      description: "CLI executable was not found on this system.",
    };
  }

  // Check if adapter is missing
  if (
    observation.adapter?.availability === "missing" ||
    entry.adapter?.availability === "missing"
  ) {
    return {
      key: "missing_adapter",
      label: "Adapter missing",
      tone: "warning",
      description: "CLI binary exists, but the NEXUS ACP adapter is missing.",
    };
  }

  // Check if login / authentication is required
  if (
    observation.state === "authentication_required" ||
    observation.state === "expired" ||
    observation.authStatus === "unauthenticated" ||
    observation.authStatus === "expired"
  ) {
    return {
      key: "connection_required",
      label: "Connection required",
      tone: "warning",
      description: "Sign-in is required through the provider CLI.",
    };
  }

  if (observation.state === "connected") {
    return {
      key: "connected",
      label: "Connected",
      tone: "good",
      description: "Authenticated and ready to execute missions.",
    };
  }

  if (observation.state === "degraded") {
    return {
      key: "degraded",
      label: "Degraded",
      tone: "warning",
      description: "Operational with warnings or limited capabilities.",
    };
  }

  if (observation.state === "error" || observation.state === "disconnected") {
    return {
      key: "failed",
      label: "Failed",
      tone: "danger",
      description: "Connection probe failed or reported an unrecoverable error.",
    };
  }

  if (observation.state === "detected") {
    return {
      key: "detected",
      label: "Detected",
      tone: "good",
      description: "CLI executable detected and ready for adapter checks.",
    };
  }

  return {
    key: "failed",
    label: observation.state.replaceAll("_", " "),
    tone: "danger",
    description: "Provider reported an unrecognized state.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workers
// ─────────────────────────────────────────────────────────────────────────────

export type WorkerState = "accepting" | "saturated" | "degraded" | "disconnected" | "revoked";

/**
 * Displayed worker state.
 *
 * Revocation takes precedence over everything else, followed by actual
 * connection status, and finally current capacity load.
 */
export function workerState(worker: WorkerRow): WorkerState {
  if (worker.trust === "REVOKED" || worker.status === "REVOKED") return "revoked";
  if (!worker.connected) return "disconnected";
  if (worker.status === "DEGRADED") return "degraded";
  if (worker.health.activeTasks >= worker.health.maxConcurrentTasks) return "saturated";
  return "accepting";
}

export const WORKER_LABELS: Record<WorkerState, string> = {
  accepting: "available",
  saturated: "saturated",
  degraded: "degraded",
  disconnected: "disconnected",
  revoked: "revoked",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes assigned workers for a task.
 */
export function selectedWorkers(task: TaskRow): { id: string; name: string; steps: number }[] {
  const counts = new Map<string, { name: string; steps: number }>();

  for (const step of task.steps) {
    if (step.selectedDeviceId === null) continue;

    const existing = counts.get(step.selectedDeviceId);
    counts.set(step.selectedDeviceId, {
      name: step.selectedDeviceName ?? step.selectedDeviceId,
      steps: (existing?.steps ?? 0) + 1,
    });
  }

  return [...counts.entries()].map(([id, value]) => ({ id, ...value }));
}

/** Failed steps within a task. */
export function failedSteps(task: TaskRow): TaskRow["steps"] {
  return task.steps.filter((step) => step.error !== null || step.status === "failed");
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable duration. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${String(minutes)} min ${String(seconds)} s`;
}

/**
 * Relative age of an ISO timestamp.
 */
export function formatAge(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "never";

  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";

  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1_000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3_600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3_600))}h ago`;

  return `${String(Math.floor(seconds / 86_400))}d ago`;
}

/** Compact number formatter. */
export function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} k`;
  return `${(value / 1_000_000).toFixed(1)} M`;
}

/**
 * Sorts recent activity in descending chronological order.
 */
export function sortActivity(entries: readonly ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort((left, right) => (left.at < right.at ? 1 : -1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Latency Visualization & Capability Presets (GA4)
// ─────────────────────────────────────────────────────────────────────────────

export interface LatencyVisual {
  text: string;
  tone: "ok" | "degraded" | "down" | "unknown";
  percent: number;
}

/**
 * Formats heartbeat latency into bounded visual metrics.
 *
 * Latency buckets:
 * - < 50ms: optimal ("ok")
 * - 50ms - 150ms: acceptable ("degraded")
 * - > 150ms: high latency ("down")
 * - null: unknown / offline ("unknown")
 *
 * Visual percent is bounded between 0% and 100% against a 300ms ceiling.
 */
export function formatLatency(latencyMs: number | null): LatencyVisual {
  if (latencyMs === null || Number.isNaN(latencyMs) || latencyMs < 0) {
    return { text: "—", tone: "unknown", percent: 0 };
  }

  const rounded = Math.round(latencyMs);
  const text = `${String(rounded)} ms`;
  const percent = Math.min(100, Math.max(0, Math.round((rounded / 300) * 100)));

  if (rounded < 50) {
    return { text, tone: "ok", percent };
  }
  if (rounded <= 150) {
    return { text, tone: "degraded", percent };
  }
  return { text, tone: "down", percent };
}

export interface PermissionOption {
  id: string;
  label: string;
  category: "System" | "Android" | "Hardware & Sensors" | "Home Assistant" | "Browser";
  description: string;
}

export const KNOWN_PERMISSIONS: readonly PermissionOption[] = [
  // System
  {
    id: "terminal.execute",
    label: "Terminal execution",
    category: "System",
    description: "Execute shell commands on host",
  },
  {
    id: "filesystem.read",
    label: "Filesystem read",
    category: "System",
    description: "Read files from workspace",
  },
  {
    id: "filesystem.write",
    label: "Filesystem write",
    category: "System",
    description: "Modify files in workspace",
  },
  {
    id: "docker.execute",
    label: "Docker execution",
    category: "System",
    description: "Run and manage Docker containers",
  },
  {
    id: "git.execute",
    label: "Git execution",
    category: "System",
    description: "Execute Git operations",
  },
  {
    id: "process.start",
    label: "Process start",
    category: "System",
    description: "Launch background processes",
  },
  {
    id: "process.stop",
    label: "Process stop",
    category: "System",
    description: "Terminate background processes",
  },

  // Android
  {
    id: "android.app.open",
    label: "Android launch app",
    category: "Android",
    description: "Open Android applications",
  },
  {
    id: "android.ui.click",
    label: "Android UI click",
    category: "Android",
    description: "Tap and click screen elements",
  },
  {
    id: "android.ui.input",
    label: "Android UI input",
    category: "Android",
    description: "Type text into inputs",
  },
  {
    id: "android.ui.screenshot",
    label: "Android screenshot",
    category: "Android",
    description: "Capture screen frame",
  },
  {
    id: "android.notification",
    label: "Android notification",
    category: "Android",
    description: "Post device notifications",
  },

  // Hardware & Sensors
  {
    id: "gpu.compute",
    label: "GPU compute",
    category: "Hardware & Sensors",
    description: "Execute heavy GPU compute jobs",
  },
  {
    id: "gpu.inference",
    label: "GPU inference",
    category: "Hardware & Sensors",
    description: "Run local model inference on VRAM",
  },
  {
    id: "camera.capture",
    label: "Camera capture",
    category: "Hardware & Sensors",
    description: "Capture still camera frames",
  },
  {
    id: "camera.stream",
    label: "Camera stream",
    category: "Hardware & Sensors",
    description: "Stream live camera video",
  },
  {
    id: "sensor.temperature",
    label: "Temperature sensor",
    category: "Hardware & Sensors",
    description: "Read ambient thermal sensors",
  },
  {
    id: "sensor.presence",
    label: "Presence sensor",
    category: "Hardware & Sensors",
    description: "Detect physical room presence",
  },

  // Home Assistant
  {
    id: "homeassistant.read",
    label: "Home Assistant read",
    category: "Home Assistant",
    description: "Read entity states and history",
  },
  {
    id: "homeassistant.write",
    label: "Home Assistant write",
    category: "Home Assistant",
    description: "Trigger service calls and state mutations",
  },

  // Browser
  {
    id: "browser.open",
    label: "Browser open",
    category: "Browser",
    description: "Open browser tabs",
  },
  {
    id: "browser.navigate",
    label: "Browser navigate",
    category: "Browser",
    description: "Navigate to external URLs",
  },
  {
    id: "browser.interact",
    label: "Browser interact",
    category: "Browser",
    description: "Click and input in browser pages",
  },
];

export const PERMISSION_PRESETS: Record<string, string[]> = {
  Workstation: [
    "terminal.execute",
    "filesystem.read",
    "filesystem.write",
    "docker.execute",
    "git.execute",
  ],
  "Read-Only": ["filesystem.read", "sensor.temperature", "sensor.presence", "homeassistant.read"],
  "Full Automation": [
    "terminal.execute",
    "filesystem.read",
    "filesystem.write",
    "docker.execute",
    "git.execute",
    "gpu.compute",
    "gpu.inference",
    "camera.capture",
    "homeassistant.read",
    "homeassistant.write",
  ],
  "Clear All": [],
};

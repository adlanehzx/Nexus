import { z } from "zod";
import type { Permission, ToolDefinition } from "@nexus/tools";
import { permissionForCapability } from "./capabilities.js";
import { CapabilityNotRegisteredError, NoEligibleWorkerError } from "./errors.js";
import type { DeviceRegistry } from "./registry.js";
import type { DeviceSelector } from "./selector.js";
import type { WorkerTransport } from "./coordinator.js";
import type { RiskLevel } from "@nexus/tools";

/**
 * Device capability bridge -> `ToolDefinition`.
 *
 * Capabilities map directly into standard tools within the existing `ToolRegistry`.
 * Permissions, human confirmation requirements, argument validation, and audit
 * logging apply uniformly.
 *
 * The LLM only sees generic tools like `device.terminal.execute` without needing
 * to know which host executes it. The selector dynamically routes requests to capable workers.
 */

/** Default risk level for capabilities when not explicitly configured. */
const CAPABILITY_RISK: Record<string, RiskLevel> = {
  "filesystem.read": "SAFE",
  "process.list": "SAFE",
  "android.ui.screenshot": "SAFE",
  "browser.open": "LOW",
  "browser.navigate": "LOW",
  "android.app.open": "LOW",
  "android.ui.scroll": "LOW",
  "filesystem.write": "MEDIUM",
  "browser.interact": "MEDIUM",
  "browser.login": "HIGH",
  "browser.purchase": "CRITICAL",
  "android.ui.click": "MEDIUM",
  "android.ui.input": "MEDIUM",
  "android.notification": "MEDIUM",
  "git.execute": "MEDIUM",
  "docker.execute": "HIGH",
  "process.start": "HIGH",
  "process.stop": "HIGH",
  "terminal.execute": "HIGH",
};

export function defaultRiskFor(capability: string): RiskLevel {
  return CAPABILITY_RISK[capability] ?? "HIGH";
}

const deviceToolOutputSchema = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  result: z.unknown(),
});
type DeviceToolOutput = z.infer<typeof deviceToolOutputSchema>;

export interface DeviceToolSpec {
  /** Capability name, e.g. `terminal.execute`. */
  capability: string;
  description: string;
  /** Schema of arguments forwarded to the worker. */
  inputSchema: z.ZodType<Record<string, unknown>>;
  inputJsonSchema?: Record<string, unknown>;
  riskLevel?: RiskLevel;
  timeoutMs?: number;
  /** Additional capabilities required from the worker. */
  alsoRequires?: string[];
}

export interface DeviceToolsOptions {
  registry: DeviceRegistry;
  selector: DeviceSelector;
  transport: WorkerTransport;
  /** User permissions evaluated at selection time. */
  userPermissions?: () => readonly string[];
  specs: DeviceToolSpec[];
}

/** Canonical tool name in the tool registry. */
export function deviceToolName(capability: string): string {
  return `device.${capability}`;
}

/**
 * Builds device tools for the `ToolRegistry`.
 */
export function createDeviceTools(options: DeviceToolsOptions): ToolDefinition<never, unknown>[] {
  return options.specs.map(
    (spec) => makeTool(spec, options) as unknown as ToolDefinition<never, unknown>,
  );
}

function makeTool(
  spec: DeviceToolSpec,
  options: DeviceToolsOptions,
): ToolDefinition<Record<string, unknown>, DeviceToolOutput> {
  const required = [spec.capability, ...(spec.alsoRequires ?? [])];
  const risk = spec.riskLevel ?? defaultRiskFor(spec.capability);

  return {
    name: deviceToolName(spec.capability),
    description: `${spec.description} NEXUS automatically selects an eligible device; do not request a specific device.`,
    version: "1",
    inputSchema: spec.inputSchema,
    ...(spec.inputJsonSchema ? { inputJsonSchema: spec.inputJsonSchema } : {}),
    outputSchema: deviceToolOutputSchema,
    riskLevel: risk,
    requiredPermissions: required.map(permissionForCapability) as Permission[],
    requiresConfirmation: risk !== "SAFE" && risk !== "LOW",
    idempotent: risk === "SAFE",
    timeoutMs: spec.timeoutMs ?? 300_000,
    summarize: (input) => `${spec.capability} — ${JSON.stringify(input).slice(0, 160)}`,

    execute: async (input, context): Promise<DeviceToolOutput> => {
      const selection = await options.selector.select({
        userId: context.userId,
        requiredCapabilities: required,
        ...(options.userPermissions ? { userPermissions: options.userPermissions() } : {}),
      });

      const device = selection.device;
      context.onProgress({ label: `Executing on ${device.name}` });

      const fresh = await options.registry.requireDevice(device.id);
      if (!fresh.capabilities.some((c) => c.enabled && c.name === spec.capability)) {
        throw new CapabilityNotRegisteredError(device.id, spec.capability);
      }

      const result = await options.transport.dispatch({
        deviceId: device.id,
        taskId: context.runId,
        stepId: context.idempotencyKey,
        tool: deviceToolName(spec.capability),
        arguments: input,
        timeoutMs: spec.timeoutMs ?? 300_000,
        capability: spec.capability,
        signal: context.signal,
        onProgress: (progress) => {
          context.onProgress({
            ...(progress.percent === undefined ? {} : { pct: progress.percent }),
            ...(progress.label === undefined ? {} : { label: progress.label }),
          });
        },
      });

      if (!result.ok) {
        throw new NoEligibleWorkerError(required, [
          result.error?.message ?? `execution failed on ${device.name}`,
        ]);
      }

      return { deviceId: device.id, deviceName: device.name, result: result.result ?? null };
    },
  };
}

/**
 * Standard device tool specifications.
 */
export function standardDeviceToolSpecs(): DeviceToolSpec[] {
  return [
    {
      capability: "terminal.execute",
      description: "Executes a command in a terminal on the user's computer.",
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
      }),
      inputJsonSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
          cwd: { type: "string", description: "Working directory" },
        },
        required: ["command"],
      },
      riskLevel: "HIGH",
    },
    {
      capability: "filesystem.read",
      description: "Reads a file on the user's computer.",
      inputSchema: z.object({ path: z.string().min(1) }),
      inputJsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      riskLevel: "SAFE",
    },
    {
      capability: "filesystem.write",
      description: "Writes a file on the user's computer.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
      inputJsonSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      riskLevel: "MEDIUM",
    },
    {
      capability: "android.notification",
      description: "Sends a notification to the user's Android device.",
      inputSchema: z.object({
        title: z.string().min(1),
        body: z.string(),
      }),
      inputJsonSchema: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title", "body"],
      },
      riskLevel: "MEDIUM",
    },
  ];
}

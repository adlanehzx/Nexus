import { z } from "zod";
import type { Permission, ToolDefinition } from "@nexus/tools";
import { permissionForCapability } from "./capabilities.js";
import { CapabilityNotRegisteredError, NoEligibleWorkerError } from "./errors.js";
import type { DeviceRegistry } from "./registry.js";
import type { DeviceSelector } from "./selector.js";
import type { WorkerTransport } from "./coordinator.js";
import type { RiskLevel } from "@nexus/tools";

/**
 * Pont capacité d'appareil → `ToolDefinition`.
 *
 * **On ne crée pas un second système d'outils.** Une capacité devient un outil
 * ordinaire du `ToolRegistry` existant, exactement comme le fait `McpManager`.
 * Conséquence directe : permissions, confirmations, validation d'arguments,
 * délais, reprises et journal d'audit s'appliquent sans une ligne de code
 * supplémentaire.
 *
 * L'agent ne voit donc jamais d'appareil. Il voit `device.terminal.execute` et
 * ignore lequel de ses trois ordinateurs l'exécutera — c'est le sélecteur qui
 * tranche, au moment de l'appel, sur des capacités.
 */

/** Risque par défaut d'une capacité, quand rien de plus précis n'est déclaré. */
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
  // Se connecter engage l'identite de l'utilisateur sur un site tiers.
  "browser.login": "HIGH",
  // Un achat est irreversible et engage financierement. Sans cette ligne il
  // retomberait sur le defaut HIGH, et un deploiement qui n'exige une
  // confirmation qu'au niveau CRITICAL laisserait passer un paiement.
  "browser.purchase": "CRITICAL",
  "android.ui.click": "MEDIUM",
  "android.ui.input": "MEDIUM",
  "android.notification": "MEDIUM",
  "git.execute": "MEDIUM",
  "docker.execute": "HIGH",
  "process.start": "HIGH",
  "process.stop": "HIGH",
  // Une commande shell arbitraire est ce qui se rapproche le plus d'un accès
  // total à la machine : elle ne descend jamais sous HIGH par défaut.
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
  /** Capacité exercée, par exemple `terminal.execute`. */
  capability: string;
  description: string;
  /** Schéma des arguments transmis au worker. */
  inputSchema: z.ZodType<Record<string, unknown>>;
  inputJsonSchema?: Record<string, unknown>;
  riskLevel?: RiskLevel;
  timeoutMs?: number;
  /** Capacités supplémentaires exigées de l'exécutant. */
  alsoRequires?: string[];
}

export interface DeviceToolsOptions {
  registry: DeviceRegistry;
  selector: DeviceSelector;
  transport: WorkerTransport;
  /** Permissions de l'utilisateur, consultées à la sélection. */
  userPermissions?: () => readonly string[];
  specs: DeviceToolSpec[];
}

/** Nom canonique d'un outil d'appareil dans le registre. */
export function deviceToolName(capability: string): string {
  return `device.${capability}`;
}

/**
 * Construit les outils d'appareil pour le `ToolRegistry`.
 *
 * Un outil par capacité, pas un par appareil : le modèle choisit *ce qu'il veut
 * faire*, jamais *où*. C'est ce qui empêche l'agent de développer des préférences
 * matérielles et ce qui rend un appareil remplaçable sans rien changer au prompt.
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
    description: `${spec.description} NEXUS choisit lui-même l'appareil capable de le faire ; ne demande pas un appareil en particulier.`,
    version: "1",
    inputSchema: spec.inputSchema,
    ...(spec.inputJsonSchema ? { inputJsonSchema: spec.inputJsonSchema } : {}),
    outputSchema: deviceToolOutputSchema,
    riskLevel: risk,
    // La permission porte le nom de la capacité : ce que l'utilisateur lit dans
    // ses réglages est exactement ce que l'appareil exerce.
    requiredPermissions: required.map(permissionForCapability) as Permission[],
    requiresConfirmation: risk !== "SAFE" && risk !== "LOW",
    // Une action d'appareil n'est jamais rejouée seule : on ne peut pas savoir
    // si la première tentative a déjà supprimé le fichier.
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
      context.onProgress({ label: `Exécution sur ${device.name}` });

      // Revérification juste avant l'appel : l'appareil a pu perdre la capacité
      // entre la sélection et le dispatch. Une ligne, contre une exécution non
      // autorisée.
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
          result.error?.message ?? `l'exécution a échoué sur ${device.name}`,
        ]);
      }

      return { deviceId: device.id, deviceName: device.name, result: result.result ?? null };
    },
  };
}

/**
 * Jeu d'outils de base, dérivé du catalogue de capacités.
 *
 * Volontairement restreint : chaque outil ajouté élargit ce que l'agent peut
 * tenter. On en ajoute quand un worker sait réellement le faire, pas « au cas
 * où ».
 */
export function standardDeviceToolSpecs(): DeviceToolSpec[] {
  return [
    {
      capability: "terminal.execute",
      description: "Exécute une commande dans un terminal sur un ordinateur de l'utilisateur.",
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
      }),
      inputJsonSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Commande à exécuter" },
          cwd: { type: "string", description: "Répertoire de travail" },
        },
        required: ["command"],
      },
      riskLevel: "HIGH",
    },
    {
      capability: "filesystem.read",
      description: "Lit un fichier sur un ordinateur de l'utilisateur.",
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
      description: "Écrit un fichier sur un ordinateur de l'utilisateur.",
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
      description: "Envoie une notification sur le téléphone Android de l'utilisateur.",
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

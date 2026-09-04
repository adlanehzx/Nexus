import type { z } from "zod";
import type { RiskLevel } from "@nexus/tools";
import type { WorkerCapability } from "@nexus/protocol";
import { CapabilityInputError, CapabilityUnavailableError } from "./errors.js";

/**
 * Registre local des capacités.
 *
 * **Ce n'est pas un second registre d'outils.** `ToolRegistry` du cœur décide
 * de ce que l'agent peut demander ; celui-ci décide de ce que *cette machine*
 * sait faire. Les deux se rejoignent par le nom de la capacité, qui est aussi
 * le nom de la permission — un seul espace de nommage traverse tout le système.
 *
 * Deux conditions cumulatives pour qu'une capacité soit annoncée :
 *
 *  1. elle est **réellement disponible** — Docker n'est déclaré que si le démon
 *     répond, Git que si le binaire existe ;
 *  2. elle est **explicitement autorisée** dans la configuration.
 *
 * Annoncer une capacité qu'on ne peut pas honorer est pire que de ne pas
 * l'annoncer : le sélecteur choisirait cette machine, et l'étape échouerait
 * après avoir écarté un exécutant qui, lui, aurait su faire.
 */

export interface CapabilityContext {
  taskId: string;
  stepId: string;
  /** Annulation venue du cœur, ou de l'arrêt du worker. */
  signal: AbortSignal;
  timeoutMs: number;
  onProgress: (progress: { percent?: number; label?: string }) => void;
}

export interface LocalCapability<I = unknown, O = unknown> {
  name: string;
  description: string;
  version?: string;
  /** Schéma des arguments. Rien ne s'exécute avant de l'avoir traversé. */
  inputSchema: z.ZodType<I>;
  /** Forme JSON Schema, transmise au cœur pour que le modèle sache appeler. */
  inputJsonSchema?: Record<string, unknown>;
  riskLevel: RiskLevel;
  /** Disponibilité réelle sur cette machine. Absent = toujours disponible. */
  probe?: () => Promise<boolean>;
  /**
   * Le résultat ne doit pas être conservé par le cœur.
   *
   * Il traverse le système pour atteindre le client qui l'a demandé, et s'arrête
   * là : le journal d'exécution garde la trace de l'appel, pas la charge utile.
   * Pensé pour ce qui est irréductiblement sensible — une capture d'écran de
   * téléphone, par exemple — et qu'aucune rédaction ne peut nettoyer.
   */
  sensitiveResult?: boolean;
  /**
   * Champs d'arguments à masquer avant journalisation.
   *
   * `redact` reconnaît les noms qui trahissent un secret — `password`, `token`,
   * `apiKey`. Il ne peut rien pour un champ légitimement nommé `text`, qui se
   * trouve être le contenu qu'on saisit dans un champ de mot de passe.
   *
   * Seule la capacité sait ce que ses arguments transportent. Elle le déclare
   * ici, une fois, plutôt que d'espérer qu'une heuristique le devine.
   */
  secretArguments?: readonly string[];
  execute: (input: I, context: CapabilityContext) => Promise<O>;
}

export interface CapabilityDeclaration {
  capability: WorkerCapability;
  available: boolean;
  reason?: string;
}

export class LocalCapabilityRegistry {
  readonly #capabilities = new Map<string, LocalCapability<never, unknown>>();
  /** Résultat des sondes, calculé au démarrage et à chaque réenregistrement. */
  readonly #availability = new Map<string, boolean>();
  readonly #allowed: Set<string> | undefined;

  /**
   * @param allowed Capacités autorisées par la configuration. `undefined` ou
   *   liste vide signifie « toutes celles réellement disponibles » — un poste
   *   dédié n'a pas à énumérer ce qu'il sait faire.
   */
  constructor(allowed?: readonly string[]) {
    this.#allowed = allowed === undefined || allowed.length === 0 ? undefined : new Set(allowed);
  }

  register<I, O>(capability: LocalCapability<I, O>): this {
    if (this.#capabilities.has(capability.name)) {
      throw new CapabilityUnavailableError(capability.name, "déjà enregistrée");
    }
    this.#capabilities.set(
      capability.name,
      capability as unknown as LocalCapability<never, unknown>,
    );
    return this;
  }

  registerAll(capabilities: readonly LocalCapability<never, unknown>[]): this {
    for (const capability of capabilities) this.register(capability);
    return this;
  }

  has(name: string): boolean {
    return this.#capabilities.has(name);
  }

  get names(): string[] {
    return [...this.#capabilities.keys()].sort();
  }

  /**
   * Récupère une capacité prête à l'emploi.
   *
   * @throws {CapabilityUnavailableError} si elle est inconnue, non autorisée par
   *   la configuration, ou indisponible sur cette machine. Les trois cas sont
   *   distingués dans le contexte de l'erreur : « Docker n'est pas installé » et
   *   « Docker n'est pas autorisé ici » n'appellent pas la même correction.
   */
  require(name: string): LocalCapability<never, unknown> {
    const capability = this.#capabilities.get(name);
    if (capability === undefined) {
      throw new CapabilityUnavailableError(name, "non implémentée sur cet appareil");
    }
    if (this.#allowed !== undefined && !this.#allowed.has(name)) {
      throw new CapabilityUnavailableError(name, "non autorisée par la configuration locale");
    }
    if (this.#availability.get(name) === false) {
      throw new CapabilityUnavailableError(name, "outil absent ou service indisponible");
    }
    return capability;
  }

  /**
   * Valide des arguments contre le schéma de la capacité.
   *
   * @throws {CapabilityInputError} avec le chemin des champs fautifs. Un message
   *   qui ne nomme pas le champ oblige à relire le schéma pour comprendre — on
   *   les nomme.
   */
  validateInput(name: string, input: unknown): unknown {
    const capability = this.require(name);
    const parsed = capability.inputSchema.safeParse(input);
    if (parsed.success) return parsed.data;

    throw new CapabilityInputError(
      name,
      parsed.error.issues.map((issue) =>
        issue.path.length === 0 ? issue.message : `${issue.path.join(".")} : ${issue.message}`,
      ),
    );
  }

  /** Exécute les sondes. À rappeler quand l'environnement a pu changer. */
  async probeAll(): Promise<void> {
    for (const [name, capability] of this.#capabilities) {
      if (capability.probe === undefined) {
        this.#availability.set(name, true);
        continue;
      }
      try {
        this.#availability.set(name, await capability.probe());
      } catch {
        // Une sonde qui échoue vaut une indisponibilité : dans le doute, on
        // n'annonce pas.
        this.#availability.set(name, false);
      }
    }
  }

  /**
   * Ce que le worker annonce au cœur.
   *
   * Seules les capacités disponibles **et** autorisées y figurent. C'est cette
   * liste que `DeviceRegistry.updateCapabilities` enregistre ; une capacité qui
   * disparaît d'ici disparaît du registre, et cesse d'être sélectionnée.
   */
  declare(): WorkerCapability[] {
    const declared: WorkerCapability[] = [];

    for (const [name, capability] of this.#capabilities) {
      if (this.#allowed !== undefined && !this.#allowed.has(name)) continue;
      if (this.#availability.get(name) === false) continue;

      declared.push({
        name,
        version: capability.version ?? "1",
        description: capability.description,
        ...(capability.inputJsonSchema === undefined
          ? {}
          : { inputSchema: capability.inputJsonSchema }),
        enabled: true,
        metadata: { risk: capability.riskLevel },
      });
    }

    return declared.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** État détaillé, pour le diagnostic et les journaux de démarrage. */
  inventory(): CapabilityDeclaration[] {
    return [...this.#capabilities.entries()].map(([name, capability]) => {
      const allowed = this.#allowed === undefined || this.#allowed.has(name);
      const present = this.#availability.get(name) !== false;

      return {
        capability: {
          name,
          version: capability.version ?? "1",
          description: capability.description,
          enabled: allowed && present,
          metadata: { risk: capability.riskLevel },
        },
        available: allowed && present,
        ...(allowed
          ? present
            ? {}
            : { reason: "outil absent sur cette machine" }
          : { reason: "non autorisée par la configuration" }),
      };
    });
  }
}

import { ConflictError } from "@nexus/shared";
import type { ToolDefinition } from "./definition.js";
import { ToolNotFoundError } from "./errors.js";
import { missingPermissions } from "./permissions.js";

/**
 * Registre des outils.
 *
 * C'est la **seule** surface par laquelle une capacité existe pour l'agent. Un
 * outil absent du registre est inexistant : le modèle n'en voit pas la
 * description, et une tentative d'appel par son nom échoue en `TOOL_NOT_FOUND`.
 *
 * Le registre ne connaît ni le LLM ni la persistance. Ajouter une source
 * (MCP, navigateur, appareil) consiste à enregistrer d'autres définitions —
 * jamais à modifier le cœur agent.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition<never, unknown>>();
  readonly #listeners = new Set<() => void>();

  /**
   * @param replace autorise le remplacement d'un outil déjà enregistré.
   *   Refusé par défaut : un doublon silencieux est une source de bugs pénible
   *   à diagnostiquer, surtout avec plusieurs sources d'outils.
   */
  register<I, O>(tool: ToolDefinition<I, O>, options?: { replace?: boolean }): this {
    if (this.#tools.has(tool.name) && options?.replace !== true) {
      throw new ConflictError({
        message: `Outil déjà enregistré : ${tool.name}`,
        userMessage: "This tool is already registered.",
        context: { toolName: tool.name },
      });
    }
    this.#tools.set(tool.name, tool as unknown as ToolDefinition<never, unknown>);
    this.#notify();
    return this;
  }

  registerAll(tools: readonly ToolDefinition<never, unknown>[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  unregister(name: string): boolean {
    const removed = this.#tools.delete(name);
    if (removed) this.#notify();
    return removed;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Retourne l'outil ou `undefined`. Voir `require` pour la variante stricte. */
  get(name: string): ToolDefinition<never, unknown> | undefined {
    return this.#tools.get(name);
  }

  /** Comme `get`, mais lève `ToolNotFoundError` — utilisé par l'exécuteur. */
  require(name: string): ToolDefinition<never, unknown> {
    const tool = this.#tools.get(name);
    if (!tool) throw new ToolNotFoundError(name);
    return tool;
  }

  list(): ToolDefinition<never, unknown>[] {
    return [...this.#tools.values()];
  }

  get size(): number {
    return this.#tools.size;
  }

  /**
   * Outils dont toutes les permissions requises sont couvertes.
   *
   * C'est la défense la plus efficace, bien avant le prompt : un outil que
   * l'utilisateur n'a pas autorisé n'est **pas décrit au modèle**, donc le
   * modèle ne peut pas être tenté de l'appeler.
   */
  listAllowed(grantedPermissions: readonly string[]): ToolDefinition<never, unknown>[] {
    return this.list().filter(
      (tool) => missingPermissions(grantedPermissions, tool.requiredPermissions).length === 0,
    );
  }

  /** Notifie d'un changement de catalogue (rechargement à chaud d'un serveur MCP). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  clear(): void {
    this.#tools.clear();
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

import { ConflictError } from "@nexus/shared";
import type { ToolDefinition } from "./definition.js";
import { ToolNotFoundError } from "./errors.js";
import { missingPermissions } from "./permissions.js";

/**
 * Capability tool registry.
 * The sole surface through which agent tools exist.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition<never, unknown>>();
  readonly #listeners = new Set<() => void>();

  register<I, O>(tool: ToolDefinition<I, O>, options?: { replace?: boolean }): this {
    if (this.#tools.has(tool.name) && options?.replace !== true) {
      throw new ConflictError({
        message: `Tool already registered: ${tool.name}`,
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

  get(name: string): ToolDefinition<never, unknown> | undefined {
    return this.#tools.get(name);
  }

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

  /** Returns tools whose required permissions are covered by granted permissions. */
  listAllowed(grantedPermissions: readonly string[]): ToolDefinition<never, unknown>[] {
    return this.list().filter(
      (tool) => missingPermissions(grantedPermissions, tool.requiredPermissions).length === 0,
    );
  }

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

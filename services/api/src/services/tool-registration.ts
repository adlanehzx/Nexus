import { createOsintTools } from "@nexus/osint";
import { createHomeTools, type HomeToolsHost } from "@nexus/devices";
import type { ToolDefinition, ToolRegistry } from "@nexus/tools";
import type { OsintService } from "./osint-service.js";

/**
 * Tool registration, declared per domain instead of inline in the container.
 *
 * Every domain that exposes tools used to reach into `ServiceContainer` and add
 * its own `registerAll` call. With six lots adding or moving tool domains, that
 * made one constructor the single busiest merge point in the repository.
 *
 * A domain now declares itself here: a name, and a function that returns its
 * tools given whatever it needs. The container composes the list and no longer
 * has to know what any individual domain is.
 *
 * Browser tools are deliberately absent. They are re-registered whenever a
 * worker connects or disconnects, so they belong to the container's lifecycle
 * methods rather than to boot-time composition.
 */

/** What a domain may draw on to build its tools. */
export interface ToolDomainContext {
  readonly osint: OsintService;
  /** Lab 4 — house devices, scenes. Absent = domain contributes nothing. */
  readonly domotique?: HomeToolsHost | undefined;
}

export interface ToolDomain {
  /** Diagnostic name. Appears in registration logs, not in tool names. */
  readonly name: string;
  /** Returns the tools to register, or none when the domain is unavailable. */
  readonly tools: (context: ToolDomainContext) => readonly ToolDefinition<never, unknown>[];
}

/**
 * Domains registered at container construction.
 *
 * Adding a domain is one entry here. It is the whole point: lot 3.1 has four
 * tool factories written and never registered — `createDocumentTools`,
 * `createGoogleWorkspaceTools`, `createDeviceTools`, `createActivepiecesTools` —
 * and each of them lands as one line in this array rather than as a diff
 * against the container constructor.
 */
export const TOOL_DOMAINS: readonly ToolDomain[] = [
  {
    name: "osint",
    tools: (context) => createOsintTools(context.osint),
  },
  {
    name: "domotique",
    tools: (context) => (context.domotique === undefined ? [] : createHomeTools(context.domotique)),
  },
];

/** Registers every declared domain. Returns the names registered, for logging. */
export function registerToolDomains(
  registry: ToolRegistry,
  context: ToolDomainContext,
): readonly string[] {
  const registered: string[] = [];
  for (const domain of TOOL_DOMAINS) {
    const tools = domain.tools(context);
    if (tools.length === 0) continue;
    registry.registerAll(tools);
    registered.push(domain.name);
  }
  return registered;
}

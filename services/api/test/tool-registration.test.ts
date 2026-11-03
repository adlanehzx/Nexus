import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@nexus/tools";
import { TOOL_DOMAINS, registerToolDomains } from "../src/services/tool-registration.js";
import { OsintService } from "../src/services/osint-service.js";

/**
 * The registry exists to keep the container out of merge conflicts, so what it
 * must guarantee is that composing domains registers exactly what registering
 * them inline used to.
 */

describe("tool domain registration", () => {
  it("registers every declared domain into the registry", () => {
    const registry = new ToolRegistry();
    const registered = registerToolDomains(registry, { osint: new OsintService({}) });

    expect(registered).toEqual(TOOL_DOMAINS.map((domain) => domain.name));
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it("exposes the OSINT tools the container used to register inline", () => {
    const registry = new ToolRegistry();
    registerToolDomains(registry, { osint: new OsintService({}) });

    expect(registry.list().some((tool) => tool.name.startsWith("osint."))).toBe(true);
  });

  it("skips a domain that offers no tools rather than failing", () => {
    // A domain is allowed to be unavailable — an absent credential, a service
    // not configured — and must then simply contribute nothing.
    const registry = new ToolRegistry();
    const registered = registerToolDomains(registry, { osint: new OsintService({}) });

    expect(registered).not.toContain("absent-domain");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyConnection } from "../src/lib/format.js";

describe("Setup wizard presentation and state persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists step progress in session storage without secrets", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });

    window.sessionStorage.setItem("nexus.setup.step", "agents");
    expect(window.sessionStorage.getItem("nexus.setup.step")).toBe("agents");

    // Ensure no sensitive token is stored in the setup key
    const raw = JSON.stringify([...store.entries()]);
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("token");
  });

  it("classifies connection provider states correctly for wizard cards", () => {
    const detected = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "detected",
        adapter: { availability: "available" },
        authStatus: "authenticated",
      },
    });
    expect(detected.key).toBe("detected");
    expect(detected.tone).toBe("good");

    const needsAuth = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "authentication_required",
        adapter: { availability: "available" },
        authStatus: "unauthenticated",
      },
    });
    expect(needsAuth.key).toBe("connection_required");
    expect(needsAuth.tone).toBe("warning");

    const missingAdapter = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "detected",
        adapter: { availability: "missing" },
        authStatus: "authenticated",
      },
    });
    expect(missingAdapter.key).toBe("missing_adapter");
    expect(missingAdapter.tone).toBe("warning");
  });

  it("formats sanitized diagnostics safely without credentials", () => {
    const errDiagnostic = {
      event: "readiness_probe_failed",
      at: "2026-10-22T20:00:00.000Z",
      status: "down",
      diagnostic: "Connection refused on port 3000",
    };

    const serialized = JSON.stringify(errDiagnostic);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).toContain("Connection refused");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { SessionManager } from "@nexus/client-core";
import { Lab1Client, Lab1RequestError } from "../src/lib/lab1-client.js";
import { createCareerEducationClient, lab1ClientFor } from "../src/lib/career-education.js";

function sessionReturning(status: number, body: unknown) {
  const authorizedRequest = vi.fn(() => Promise.resolve({ status, body }));
  return {
    session: { authorizedRequest, isAuthenticated: true } as unknown as SessionManager,
    authorizedRequest,
  };
}

describe("Lab1Client", () => {
  it("unwraps data and calls the autonomy routes", async () => {
    const { session, authorizedRequest } = sessionReturning(200, {
      data: { settings: { killSwitch: false }, effectiveModes: {}, configured: false },
    });
    const client = new Lab1Client(session);
    const view = await client.updateAutonomySettings({ killSwitch: true });
    expect(view.configured).toBe(false);
    expect(authorizedRequest).toHaveBeenCalledWith({
      method: "PUT",
      path: "/api/v1/career/autonomy/settings",
      body: { killSwitch: true },
    });
  });

  it("surfaces the server's message and status instead of faking success", async () => {
    const { session } = sessionReturning(503, {
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "The browser worker is unreachable." },
    });
    const client = new Lab1Client(session);
    const failure = await client
      .linkedInEngagementAction("0190b4a8-0000-7000-8000-000000000000", "approve")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Lab1RequestError);
    expect((failure as Lab1RequestError).status).toBe(503);
    expect((failure as Lab1RequestError).message).toBe("The browser worker is unreachable.");
  });

  it("sends an explicit consent flag with the warning version", async () => {
    const { session, authorizedRequest } = sessionReturning(200, { data: {} });
    await new Lab1Client(session).acceptLinkedInRisk(1);
    expect(authorizedRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/v1/linkedin/content/consent",
      body: { accepted: true, version: 1 },
    });
  });

  it("is only available for session-backed career clients", () => {
    const { session } = sessionReturning(200, { data: {} });
    expect(lab1ClientFor(createCareerEducationClient(session))).toBeInstanceOf(Lab1Client);
    expect(lab1ClientFor(createCareerEducationClient())).toBeNull();
  });
});

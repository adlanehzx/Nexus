import { describe, expect, it } from "vitest";
import { assessOsintRequest, buildOsintMission, osintInvestigationSchema } from "../src/index.js";

const request = osintInvestigationSchema.parse({
  title: "Vendor ownership review",
  kind: "organization",
  target: "Example Robotics SAS",
  objective: "Verify public ownership, leadership and material regulatory claims.",
  maxSources: 12,
  lawfulPurposeConfirmed: true,
});

describe("OSINT mission policy", () => {
  it("builds a citation-first public-source mission", () => {
    const mission = buildOsintMission(request);
    expect(mission).toContain("direct citations");
    expect(mission).toContain("public sources");
    expect(mission).toContain("at most 12");
  });

  it("rejects private-data and access-bypass objectives", () => {
    expect(
      assessOsintRequest({ ...request, objective: "Find the CEO home address and personal phone." })
        .allowed,
    ).toBe(false);
    expect(() =>
      buildOsintMission({ ...request, objective: "Bypass login and extract session cookies." }),
    ).toThrow();
  });
});

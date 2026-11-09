import { describe, expect, it, vi } from "vitest";
import type { SessionManager } from "@nexus/client-core";
import { DashboardCareerClient, type CareerOpportunityDto } from "../src/lib/career-api-client.js";
import { createCareerEducationClient } from "../src/lib/career-education.js";

const opportunity: CareerOpportunityDto = {
  id: "opp-1",
  kind: "permanent_job",
  title: "Systems engineer",
  organization: "Research Lab",
  location: "Paris",
  remote: true,
  description: "Build distributed systems",
  requirements: ["Rust"],
  compensation: null,
  postedAt: null,
  closesAt: null,
  externalRef: null,
  canonicalUrl: "https://example.com/jobs/1",
  fingerprint: "fingerprint",
  untrustedContent: true,
  provenance: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  applicationState: "drafting",
  matchExplanation: {
    opportunityId: "opp-1",
    score: 82,
    rawScore: 90,
    confidence: 0.9,
    excluded: false,
    exclusionReason: null,
    factors: [
      { factor: "profile_skills", score: 0.8, weight: 20, evidence: "Rust matches your profile" },
    ],
  },
};
const application = {
  id: "app-1",
  opportunityId: "opp-1",
  state: "interview",
  stateChangedAt: "2026-11-01",
  matchScore: 82,
  notes: "Interview scheduled",
  createdAt: "2026-11-01",
  updatedAt: "2026-11-01",
};
function setup(data: (path: string, body: unknown) => unknown) {
  const request = vi.fn(({ path, body }: { path: string; body?: unknown }) =>
    Promise.resolve({
      status: 200,
      body: { data: data(path, body) },
    }),
  );
  const session = {
    authorizedRequest: request,
    isAuthenticated: true,
  } as unknown as SessionManager;
  return { client: new DashboardCareerClient(session), request, session };
}

describe("career dashboard server contracts", () => {
  it("renders returned opportunities and server match factors, mapping CDI to permanent_job", async () => {
    const { client, request } = setup(() => ({ opportunities: [opportunity] }));
    const result = await client.searchOpportunities({ track: "cdi", minScore: 80 });
    expect(request.mock.calls[0]?.[0].path).toContain("kind=permanent_job");
    expect(result.items[0]).toMatchObject({
      title: "Systems engineer",
      track: "cdi",
      workflowStatus: "shortlisted",
      match: { score: 82, breakdown: { skills: 80 }, strengths: ["Rust matches your profile"] },
    });
    expect(result.items[0]?.citations).toEqual([]);
    expect((await client.searchOpportunities({ term: "unknown" })).total).toBe(0);
  });
  it("uses authoritative empty lists and surfaces HTTP/network failures", async () => {
    const { client, request } = setup(() => ({ opportunities: [] }));
    expect((await client.searchOpportunities({})).items).toEqual([]);
    request.mockResolvedValueOnce({ status: 503, body: { data: null } });
    await expect(client.searchOpportunities({})).rejects.toThrow();
    request.mockRejectedValueOnce(new Error("Offline"));
    await expect(client.searchOpportunities({})).rejects.toThrow("Offline");
  });
  it("hydrates server application states and accepts successful 200 creation", async () => {
    const { client, request } = setup((path) =>
      path.endsWith("/opportunities/opp-1")
        ? opportunity
        : path.endsWith("/applications")
          ? { applications: [application] }
          : application,
    );
    expect((await client.getApplications())[0]).toMatchObject({
      stage: "interviewing",
      opportunity: { title: "Systems engineer" },
    });
    request.mockResolvedValueOnce({ status: 200, body: { data: application } });
    expect((await client.createApplication("opp-1")).id).toBe("app-1");
    await client.updateApplicationStage("app-1", "preparing", "Draft resume");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        path: "/api/v1/career/applications/app-1/stage",
        body: { stage: "preparing", note: "Draft resume" },
      }),
    );
  });
  it("loads profile skills and education recommendations from the profile report", async () => {
    const { client } = setup(() => ({
      profile: {
        id: "profile-1",
        headline: "Engineer",
        summary: "Research",
        skills: ["Rust"],
        highestDegree: "master",
        languages: [{ code: "fr", level: "native" }],
        preferences: {
          kinds: ["phd", "permanent_job"],
          locations: ["Paris"],
          remote: "preferred",
          researchAreas: ["Distributed systems"],
        },
      },
      completeness: {
        score: 70,
        gaps: [{ field: "publications", reason: "Add research publications" }],
      },
    }));
    expect(await client.getProfile()).toMatchObject({
      skills: ["Rust"],
      preferredTracks: ["phd", "cdi"],
      primaryDiscipline: "Distributed systems",
      completeness: { score: 70, actionableRecommendations: ["Add research publications"] },
    });
  });
  it("reads and generates resumes from server document records", async () => {
    const document = {
      id: "doc-1",
      applicationId: "app-1",
      kind: "cv",
      revision: 1,
      parentVariantId: null,
      profileVersion: 1,
      contentHash: "server-hash",
      preview: "Resume",
      length: 6,
      body: "Resume",
      createdAt: "2026-11-01",
    };
    const { client, request } = setup((path) => {
      if (path.endsWith("/applications")) return { applications: [application] };
      if (path.endsWith("/applications/app-1/documents")) return { documents: [document] };
      if (path.endsWith("/opportunities/opp-1")) return opportunity;
      return document;
    });
    expect((await client.getDocuments())[0]).toMatchObject({
      id: "doc-1",
      type: "cv",
      markdownContent: "Resume",
      digestSha256: "server-hash",
    });
    expect(
      await client.generateDocumentVariant({ opportunityId: "opp-1", type: "cv" }),
    ).toMatchObject({ id: "doc-1" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/career/documents/tailor",
        body: { opportunityId: "opp-1", type: "cv" },
      }),
    );
  });
  it("uses the server shortlist and comparison responses", async () => {
    const { client, request } = setup((path) => {
      if (path.endsWith("/shortlist")) return application;
      if (path.endsWith("/compare"))
        return { items: [opportunity], comparisonAttributes: ["location"] };
      return opportunity;
    });
    expect((await client.toggleShortlist("opp-1", true)).workflowStatus).toBe("shortlisted");
    expect((await client.compareOpportunities(["opp-1"])).opportunities[0]?.id).toBe("opp-1");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/career/opportunities/opp-1/shortlist",
      }),
    );
  });
  it("keeps a stable authenticated client across dashboard rerenders", () => {
    const { session } = setup(() => ({}));
    expect(createCareerEducationClient(session)).toBe(createCareerEducationClient(session));
  });
  it("does not send a pretend removal to the add-only shortlist route", async () => {
    const { client, request } = setup(() => opportunity);
    await expect(client.toggleShortlist("opp-1", false)).rejects.toThrow("unavailable");
    expect(request).not.toHaveBeenCalled();
  });
  it("fetches and resolves confirmations through the server endpoints", async () => {
    const confirmation = {
      id: "conf-1",
      applicationId: "app-1",
      purpose: "submit_application",
      payloadHash: "hash-1",
      state: "pending",
      summary: "Submit dossier",
      requestedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-11-02T00:00:00.000Z",
      decidedAt: null,
      consumedAt: null,
    };
    const { client, request } = setup((path) => {
      if (path.endsWith("/confirmations")) {
        return { confirmations: [confirmation] };
      }
      return { confirmation, application };
    });
    const list = await client.getConfirmations();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "conf-1",
      title: "Approval: Submit dossier",
      status: "pending",
    });

    const resolved = await client.resolveConfirmation("conf-1", "approve");
    expect(resolved.id).toBe("conf-1");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/career/confirmations/conf-1/resolve",
      }),
    );
  });
  it("fetches, creates, and toggles deadlines through the server endpoints", async () => {
    const deadline = {
      id: "dl-1",
      applicationId: "app-1",
      kind: "interview",
      dueAt: "2026-11-10T10:00:00.000Z",
      state: "pending",
      label: "Technical interview",
      reminderOffsetsMinutes: [1440],
      remindedOffsetsMinutes: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const { client, request } = setup((path) => {
      if (path.endsWith("/applications")) return { applications: [application] };
      if (path.includes("/deadlines")) return { deadlines: [deadline] };
      return deadline;
    });
    const deadlines = await client.getDeadlines();
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toMatchObject({
      id: "dl-1",
      title: "Technical interview",
      completed: false,
    });

    await client.toggleDeadlineCompleted("dl-1", true);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        path: "/api/v1/career/deadlines/dl-1",
        body: { completed: true },
      }),
    );
  });
  it("fetches contacts through the server endpoints", async () => {
    const contact = {
      id: "ct-1",
      applicationId: "app-1",
      opportunityId: "opp-1",
      displayName: "Elena Rostova",
      role: "Head of Engineering",
      organization: "Nexus Labs",
      email: "elena@example.com",
      notes: "Met at conference",
      source: "manual_entry",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const { client } = setup(() => ({ contacts: [contact] }));
    const contacts = await client.getContacts("opp-1");
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      id: "ct-1",
      name: "Elena Rostova",
      role: "Head of Engineering",
    });
  });
  it("surfaces API failures for approvals, deadlines and contacts instead of fake data", async () => {
    const request = vi.fn(() =>
      Promise.resolve({ status: 500, body: { error: { message: "backend down" } } }),
    );
    const session = {
      authorizedRequest: request,
      isAuthenticated: true,
    } as unknown as SessionManager;
    const client = new DashboardCareerClient(session);
    await expect(client.getConfirmations()).rejects.toThrow();
    await expect(client.resolveConfirmation("conf-1", "approve")).rejects.toThrow();
    await expect(client.getDeadlines()).rejects.toThrow();
    await expect(client.toggleDeadlineCompleted("dl-1", true)).rejects.toThrow();
    await expect(client.getContacts()).rejects.toThrow();
    expect(request).toHaveBeenCalled();
  });
});

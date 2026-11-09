import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTONOMOUS_ACTOR,
  type CareerProfileInput,
  type OpportunityIngestInput,
} from "@nexus/career";
import { ConflictError } from "@nexus/shared";
import { InMemoryCareerStore } from "../src/services/career/store.js";
import { RecordingSubmissionAdapter } from "../src/services/career/submission-adapter.js";
import { CareerService } from "../src/services/career/career-service.js";
import { CareerAutonomyService } from "../src/services/career/autonomy-service.js";
import { InMemoryCareerAutonomyStore } from "../src/services/career/autonomy-store.js";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

const USER = "33333333-3333-3333-3333-333333333333";

function profile(): CareerProfileInput {
  return {
    headline: "Staff Distributed Systems Engineer",
    summary:
      "Ten years building consensus protocols, fault-tolerant distributed storage and Rust platform architecture.",
    yearsExperience: 10,
    highestDegree: "master",
    skills: ["Rust", "Distributed Systems", "Raft"],
    languages: [{ code: "en", level: "native" }],
    publications: 0,
    preferences: {
      kinds: ["permanent_job", "freelance"],
      locations: ["Paris"],
      remote: "preferred",
      languages: [{ code: "en", level: "professional" }],
      mustHaveSkills: ["Rust", "Distributed Systems"],
      niceToHaveSkills: ["Raft"],
      researchAreas: [],
      minCompensation: null,
      excludedOrganizations: [],
      noticePeriodDays: 30,
    },
  };
}

function listing(
  organization: string,
  overrides: Partial<OpportunityIngestInput> = {},
): OpportunityIngestInput {
  const slug = organization.toLowerCase().replace(/[^a-z]+/g, "-");
  return {
    kind: "permanent_job",
    title: "Senior Rust Engineer",
    organization,
    location: "Paris, France",
    remote: true,
    description: "Distributed Systems and Rust storage engines.",
    requirements: ["Rust", "Distributed Systems", "Raft"],
    compensation: null,
    postedAt: new Date("2026-10-01T10:00:00Z"),
    closesAt: new Date("2026-12-31T23:59:59Z"),
    externalRef: `ref-${slug}`,
    source: {
      kind: "official_site",
      url: `https://${slug}.example.org/jobs/rust`,
      evidence: "Official careers page",
    },
    ...overrides,
  };
}

describe("CareerAutonomyService", () => {
  let now: Date;
  let store: InMemoryCareerStore;
  let adapter: RecordingSubmissionAdapter;
  let career: CareerService;
  let autonomy: CareerAutonomyService;

  beforeEach(async () => {
    now = new Date("2026-11-09T10:00:00Z");
    store = new InMemoryCareerStore();
    adapter = new RecordingSubmissionAdapter();
    career = new CareerService({ store, adapter, now: () => now });
    autonomy = new CareerAutonomyService({
      career,
      careerStore: store,
      store: new InMemoryCareerAutonomyStore(),
      now: () => now,
    });
    await career.saveProfile(USER, profile());
  });

  const allAutonomous = {
    modes: { shortlist: "autonomous", documents: "autonomous", submission: "autonomous" },
  } as const;

  it("defaults to approval everywhere: a run only suggests and acts on nothing", async () => {
    await career.ingest(USER, [listing("Acme Storage")]);
    const view = await autonomy.settingsView(USER);
    expect(view.configured).toBe(false);
    expect(view.effectiveModes).toEqual({
      shortlist: "approval",
      documents: "approval",
      submission: "approval",
    });
    const report = await autonomy.run(USER);
    expect(report.shortlisted).toEqual([]);
    expect(report.submitted).toEqual([]);
    expect(report.suggestions.map((s) => s.organization)).toEqual(["Acme Storage"]);
    expect(await career.listApplications(USER, { limit: 10 })).toEqual([]);
  });

  it("runs the full autonomous pipeline with actor nexus-autonomous on every event", async () => {
    await career.ingest(USER, [listing("Acme Storage")]);
    await autonomy.updateSettings(USER, {
      ...allAutonomous,
      guardrails: { minMatchScore: 1, maxSubmissionsPerDay: 5 },
    });
    const report = await autonomy.run(USER);
    expect(report.errors).toEqual([]);
    expect(report.shortlisted).toHaveLength(1);
    expect(report.documentsPrepared[0]?.actor).toBe(AUTONOMOUS_ACTOR);
    expect(report.submitted).toHaveLength(1);
    expect(adapter.calls).toHaveLength(1);

    const applicationId = report.submitted[0]!.applicationId;
    const history = await career.history(USER, applicationId);
    const submitted = history.find((event) => event.kind === "application.submitted");
    expect(submitted?.actor).toBe(AUTONOMOUS_ACTOR);
    expect(history.find((event) => event.kind === "confirmation.approved")?.actor).toBe(
      AUTONOMOUS_ACTOR,
    );
    expect(history.some((event) => event.kind === "autonomy.submission.approved")).toBe(true);

    // Idempotence: replaying the submission is refused (409), never resent.
    await expect(career.submit(USER, applicationId)).rejects.toBeInstanceOf(ConflictError);
    const second = await autonomy.run(USER);
    expect(second.submitted).toEqual([]);
    expect(adapter.calls).toHaveLength(1);

    const audit = await autonomy.audit(USER, { actor: AUTONOMOUS_ACTOR, limit: 100 });
    expect(audit.length).toBeGreaterThan(3);
    expect(audit.every((event) => event.actor === AUTONOMOUS_ACTOR)).toBe(true);
  });

  it("holds back below the minimum match score (falls back to approval)", async () => {
    await career.ingest(USER, [listing("Acme Storage")]);
    await autonomy.updateSettings(USER, {
      ...allAutonomous,
      guardrails: { minMatchScore: 100 },
    });
    const report = await autonomy.run(USER);
    expect(report.shortlisted).toEqual([]);
    expect(report.suggestions).toEqual([]);
    expect(adapter.calls).toHaveLength(0);
  });

  it("enforces the daily submission cap", async () => {
    await career.ingest(USER, [
      listing("Acme Storage"),
      listing("Beta Systems"),
      listing("Gamma Cloud"),
    ]);
    await autonomy.updateSettings(USER, {
      ...allAutonomous,
      guardrails: { minMatchScore: 1, maxSubmissionsPerDay: 2 },
    });
    const report = await autonomy.run(USER);
    expect(report.submitted).toHaveLength(2);
    expect(adapter.calls).toHaveLength(2);
    const capped = report.blocked.find((b) => b.action === "submission");
    expect(capped?.reasons.map((r) => r.code)).toEqual(["daily_cap_reached"]);

    // The refusal is audited once, not on every tick.
    await autonomy.run(USER);
    const history = await career.history(USER, capped!.applicationId!);
    expect(history.filter((e) => e.kind === "autonomy.submission.blocked")).toHaveLength(1);

    // Next day the cap resets.
    now = new Date("2026-11-10T10:00:00Z");
    const tomorrow = await autonomy.run(USER);
    expect(tomorrow.submitted).toHaveLength(1);
    expect(adapter.calls).toHaveLength(3);
  });

  it("never acts on an excluded company or contract type", async () => {
    await career.ingest(USER, [
      listing("Evil Corp International"),
      listing("Freelance Shop", { kind: "freelance" }),
    ]);
    await autonomy.updateSettings(USER, {
      ...allAutonomous,
      guardrails: {
        minMatchScore: 1,
        excludedCompanies: ["evil corp"],
        excludedContractTypes: ["freelance"],
      },
    });
    const report = await autonomy.run(USER);
    expect(report.shortlisted).toEqual([]);
    expect(report.suggestions).toEqual([]);
    expect(await career.listApplications(USER, { limit: 10 })).toEqual([]);
  });

  it("kill switch pauses every autonomous action and keeps the work for approval", async () => {
    await career.ingest(USER, [listing("Acme Storage")]);
    await autonomy.updateSettings(USER, {
      ...allAutonomous,
      killSwitch: true,
      guardrails: { minMatchScore: 1 },
    });
    const view = await autonomy.settingsView(USER);
    expect(view.settings.modes.submission).toBe("autonomous");
    expect(view.effectiveModes.submission).toBe("approval");

    const report = await autonomy.run(USER);
    expect(report.shortlisted).toEqual([]);
    expect(report.suggestions).toHaveLength(1);
    expect(adapter.calls).toHaveLength(0);
  });

  it("switching modes changes behaviour without losing the other actions' settings", async () => {
    await career.ingest(USER, [listing("Acme Storage")]);
    await autonomy.updateSettings(USER, {
      modes: { shortlist: "autonomous", documents: "approval", submission: "manual" },
      guardrails: { minMatchScore: 1 },
    });
    const first = await autonomy.run(USER);
    expect(first.shortlisted).toHaveLength(1);
    expect(first.documentsPrepared[0]?.actor).toBe("nexus-prepare");
    expect(first.approvalsRequested).toEqual([]);

    // Documents prepared in approval mode wait for one-click validation.
    const queue = await autonomy.queue(USER);
    expect(queue.documentsToValidate).toHaveLength(1);
    const applicationId = queue.documentsToValidate[0]!.applicationId;
    const validated = await autonomy.validateDocuments(USER, applicationId);
    expect(validated.application.state).toBe("awaiting_confirmation");

    // Submission is manual: Nexus never approves it, even after more runs.
    await autonomy.run(USER);
    expect(adapter.calls).toHaveLength(0);

    // One click approves and submits; a second click is a 409.
    const after = await autonomy.queue(USER);
    expect(after.approvalsPending).toHaveLength(1);
    const confirmationId = after.approvalsPending[0]!.confirmationId;
    const result = await autonomy.approveAndSubmit(USER, confirmationId);
    expect(result.replayed).toBe(false);
    expect(adapter.calls).toHaveLength(1);
    await expect(autonomy.approveAndSubmit(USER, confirmationId)).rejects.toBeInstanceOf(
      ConflictError,
    );
    const history = await career.history(USER, applicationId);
    expect(history.find((e) => e.kind === "application.submitted")?.actor).toBe("owner");
  });

  it("rejects invalid settings", async () => {
    await expect(autonomy.updateSettings(USER, { timezone: "Not/AZone" })).rejects.toMatchObject({
      httpStatus: 400,
    });
  });
});

describe("career autonomy routes", () => {
  let harness: ApiHarness;
  let user: Account;
  let other: Account;

  beforeEach(async () => {
    harness = await makeApi();
    user = await createAccount(harness, "autonomy-a@example.test");
    other = await createAccount(harness, "autonomy-b@example.test");
  });

  afterEach(async () => {
    await harness.close();
  });

  it("requires authentication", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/career/autonomy/settings",
    });
    expect(response.statusCode).toBe(401);
  });

  it("persists per-user settings through GET/PUT and validates them", async () => {
    const initial = await harness.app.inject({
      method: "GET",
      url: "/api/v1/career/autonomy/settings",
      headers: user.authorization,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data.settings.modes.submission).toBe("approval");

    const put = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/career/autonomy/settings",
      headers: user.authorization,
      payload: {
        modes: { submission: "autonomous" },
        guardrails: { maxSubmissionsPerDay: 1, excludedCompanies: ["Evil Corp"] },
        killSwitch: true,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data.effectiveModes.submission).toBe("approval");

    const reread = await harness.app.inject({
      method: "GET",
      url: "/api/v1/career/autonomy/settings",
      headers: user.authorization,
    });
    expect(reread.json().data.settings.guardrails.excludedCompanies).toEqual(["Evil Corp"]);
    expect(reread.json().data.settings.killSwitch).toBe(true);

    // Isolation: the other account still has the defaults.
    const foreign = await harness.app.inject({
      method: "GET",
      url: "/api/v1/career/autonomy/settings",
      headers: other.authorization,
    });
    expect(foreign.json().data.settings.modes.submission).toBe("approval");

    const invalid = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/career/autonomy/settings",
      headers: user.authorization,
      payload: { modes: { submission: "yolo" } },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("refuses a run without a profile and exposes queue and audit", async () => {
    const run = await harness.app.inject({
      method: "POST",
      url: "/api/v1/career/autonomy/run",
      headers: user.authorization,
      payload: {},
    });
    expect(run.statusCode).toBe(409);
    const queue = await harness.app.inject({
      method: "GET",
      url: "/api/v1/career/autonomy/queue",
      headers: user.authorization,
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().data.approvalsPending).toEqual([]);
    const audit = await harness.app.inject({
      method: "GET",
      url: "/api/v1/career/autonomy/audit?actor=nexus-autonomous",
      headers: user.authorization,
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data.events).toEqual([]);
  });
});

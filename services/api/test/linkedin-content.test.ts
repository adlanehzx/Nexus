import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_AUTOMATION_CONSENT_VERSION,
  LINKEDIN_AUTONOMOUS_ACTOR,
  LinkedInClient,
} from "@nexus/linkedin";
import { ConflictError, DependencyError, RateLimitError } from "@nexus/shared";
import { LinkedInContentService } from "../src/services/linkedin-content/content-service.js";
import { InMemoryLinkedInContentStore } from "../src/services/linkedin-content/store.js";
import type { ContentDrafter } from "../src/services/linkedin-content/drafter.js";
import type {
  EngagementAction,
  EngagementExecutor,
} from "../src/services/linkedin-content/engagement-executor.js";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

const USER = "44444444-4444-4444-4444-444444444444";
const TARGET = "https://www.linkedin.com/feed/update/urn:li:activity:7001/";

class FakeDrafter implements ContentDrafter {
  readonly name = "fake";
  draftPost(input: { topic: string }) {
    return Promise.resolve({
      text: `Thoughts on ${input.topic}. #ignored`,
      hashtags: ["Rust", "OpenSource"],
    });
  }
  draftComment() {
    return Promise.resolve("Thanks for sharing this.");
  }
}

class FakeExecutor implements EngagementExecutor {
  readonly name = "fake-browser";
  available = true;
  readonly executed: EngagementAction[] = [];
  assertAvailable(): Promise<void> {
    return this.available
      ? Promise.resolve()
      : Promise.reject(
          new DependencyError({
            message: "worker down",
            userMessage: "The browser worker is unreachable.",
          }),
        );
  }
  execute(action: EngagementAction) {
    this.executed.push(action);
    return Promise.resolve({ reference: `fake:${String(this.executed.length)}` });
  }
  discover() {
    return Promise.resolve([{ target: TARGET, summary: "A post about Rust" }]);
  }
}

/** Mocked LinkedIn HTTP: userinfo then the Posts API. */
function mockLinkedInFetch(postStatus = 201) {
  return vi.fn<typeof fetch>((input) => {
    const url = urlOf(input);
    if (url.endsWith("/v2/userinfo")) {
      return Promise.resolve(
        new Response(JSON.stringify({ sub: "member123", name: "Ada" }), { status: 200 }),
      );
    }
    if (url.endsWith("/rest/posts")) {
      return Promise.resolve(
        postStatus === 201
          ? new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:999" } })
          : new Response("{}", { status: postStatus }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("LinkedInContentService", () => {
  let now: Date;
  let store: InMemoryLinkedInContentStore;
  let executor: FakeExecutor;
  let fetchFn: ReturnType<typeof mockLinkedInFetch>;
  let service: LinkedInContentService;

  function build(fetchImpl = mockLinkedInFetch()) {
    fetchFn = fetchImpl;
    service = new LinkedInContentService({
      store,
      drafter: new FakeDrafter(),
      executor,
      resolveClient: () =>
        Promise.resolve(new LinkedInClient({ accessToken: "secret-token", fetchFn })),
      now: () => now,
      random: () => 0.5,
    });
  }

  beforeEach(() => {
    now = new Date("2026-11-09T10:00:00Z"); // Monday 11:00 Paris
    store = new InMemoryLinkedInContentStore();
    executor = new FakeExecutor();
    build();
  });

  it("publishes an approved post through the official Posts API (mocked HTTP)", async () => {
    const draft = await service.createPost(USER, { text: "Hello from Nexus" });
    expect(draft.state).toBe("draft");
    const published = await service.approvePost(USER, draft.id);
    expect(published.state).toBe("published");
    expect(published.externalId).toBe("urn:li:share:999");

    const postCall = fetchFn.mock.calls.find(([url]) => urlOf(url).endsWith("/rest/posts"));
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1]?.body as string) as Record<string, unknown>;
    expect(body.author).toBe("urn:li:person:member123");
    expect(body.commentary).toBe("Hello from Nexus");
    expect(new Headers(postCall![1]?.headers).get("Authorization")).toBe("Bearer secret-token");

    // Replay is refused: a published post cannot be published again.
    await expect(service.publishNow(USER, draft.id)).rejects.toBeInstanceOf(ConflictError);

    const audit = await service.audit(USER, 20);
    expect(audit[0]?.action).toBe("post.publish");
    expect(audit[0]?.outcome).toBe("ok");
    // Never a token in the audit trail.
    expect(JSON.stringify(audit)).not.toContain("secret-token");
  });

  it("fails visibly when LinkedIn rejects the publication", async () => {
    build(mockLinkedInFetch(401));
    const draft = await service.createPost(USER, { text: "Will fail" });
    await expect(service.publishNow(USER, draft.id)).rejects.toBeInstanceOf(DependencyError);
    const [post] = await service.listPosts(USER, { limit: 5 });
    expect(post?.state).toBe("failed");
    expect(post?.failureReason).toContain("Reconnect LinkedIn");
    const audit = await service.audit(USER, 5);
    expect(audit[0]?.outcome).toBe("failed");
  });

  it("drafts posts per mode: approval queues them, autonomous schedules and publishes", async () => {
    await service.updateSettings(USER, {
      posts: {
        topics: ["Rust"],
        schedule: { daysOfWeek: [1], times: ["12:00"], timezone: "Europe/Paris" },
        hashtags: { policy: "generated", fixed: [], maxPerPost: 1 },
      },
    });
    const queued = await service.generatePost(USER);
    expect(queued.state).toBe("awaiting_approval");
    expect(queued.text).toBe("Thoughts on Rust.\n\n#Rust");
    expect(queued.scheduledAt?.toISOString()).toBe("2026-11-09T11:00:00.000Z");
    await service.rejectPost(USER, queued.id);

    await service.updateSettings(USER, { modes: { publishPost: "autonomous" } });
    await service.tickOwner(USER);
    const scheduled = await service.listPosts(USER, { states: ["scheduled"], limit: 5 });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.createdBy).toBe(LINKEDIN_AUTONOMOUS_ACTOR);

    now = new Date("2026-11-09T11:00:30Z");
    await service.tickOwner(USER);
    const [published] = await service.listPosts(USER, { states: ["published"], limit: 5 });
    expect(published?.externalId).toBe("urn:li:share:999");
    const audit = await service.audit(USER, 50);
    expect(
      audit.some((e) => e.action === "post.publish" && e.actor === LINKEDIN_AUTONOMOUS_ACTOR),
    ).toBe(true);
  });

  it("kill switch moves an autonomously scheduled post back to the approval queue", async () => {
    await service.updateSettings(USER, {
      modes: { publishPost: "autonomous" },
      posts: {
        topics: ["Rust"],
        schedule: { daysOfWeek: [1], times: ["12:00"], timezone: "Europe/Paris" },
      },
    });
    const post = await service.generatePost(USER);
    expect(post.state).toBe("scheduled");
    await service.updateSettings(USER, { killSwitch: true });
    now = new Date("2026-11-09T11:01:00Z");
    await service.tickOwner(USER);
    const after = await service.listPosts(USER, { limit: 5 });
    expect(after[0]?.state).toBe("awaiting_approval");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("enforces the weekly post cap", async () => {
    await service.updateSettings(USER, { posts: { maxPostsPerWeek: 1 } });
    await service.createPost(USER, { text: "One", scheduledAt: new Date("2026-11-10T09:00:00Z") });
    await expect(
      service.createPost(USER, { text: "Two", scheduledAt: new Date("2026-11-11T09:00:00Z") }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses autonomous engagement without the explicit consent, then accepts it", async () => {
    await expect(
      service.updateSettings(USER, { modes: { react: "autonomous" } }),
    ).rejects.toBeInstanceOf(ConflictError);
    let view = await service.settingsView(USER);
    expect(view.consent.valid).toBe(false);
    expect(view.consent.warning).toContain("User Agreement");

    await expect(
      service.acceptAutomationRisk(USER, LINKEDIN_AUTOMATION_CONSENT_VERSION + 1),
    ).rejects.toBeInstanceOf(ConflictError);
    view = await service.acceptAutomationRisk(USER, LINKEDIN_AUTOMATION_CONSENT_VERSION);
    expect(view.consent.acceptedAt).toBe(now.toISOString());
    view = await service.updateSettings(USER, { modes: { react: "autonomous" } });
    expect(view.effectiveModes.react).toBe("autonomous");

    // Withdrawing consent downgrades at once.
    view = await service.revokeAutomationRisk(USER);
    expect(view.settings.modes.react).toBe("approval");
    const audit = await service.audit(USER, 20);
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(["consent.accept", "consent.revoke"]),
    );
  });

  it("approval queue: propose, approve in one click, refuse duplicates", async () => {
    const proposed = await service.proposeEngagement(USER, { kind: "comment", target: TARGET });
    expect(proposed.state).toBe("proposed");
    expect(proposed.text).toBe("Thanks for sharing this.");
    await expect(
      service.proposeEngagement(USER, { kind: "comment", target: TARGET }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Executing goes through browser automation: consent is required.
    await expect(service.approveEngagement(USER, proposed.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(executor.executed).toHaveLength(0);

    await service.acceptAutomationRisk(USER, LINKEDIN_AUTOMATION_CONSENT_VERSION);
    const done = await service.approveEngagement(USER, proposed.id);
    expect(done.state).toBe("executed");
    expect(executor.executed[0]?.text).toBe("Thanks for sharing this.");
    // A second click is a 409, not a second comment.
    await expect(service.approveEngagement(USER, proposed.id)).rejects.toBeInstanceOf(
      ConflictError,
    );

    // Reject and manual completion paths.
    const reaction = await service.proposeEngagement(USER, { kind: "reaction", target: TARGET });
    expect(reaction.reaction).toBe("LIKE");
    const manual = await service.markEngagementDone(USER, reaction.id);
    expect(manual.executor).toBe("manual");
  });

  it("fails visibly when the browser worker is unavailable", async () => {
    await service.acceptAutomationRisk(USER, LINKEDIN_AUTOMATION_CONSENT_VERSION);
    executor.available = false;
    const item = await service.proposeEngagement(USER, { kind: "reaction", target: TARGET });
    await expect(service.approveEngagement(USER, item.id)).rejects.toBeInstanceOf(DependencyError);
    const [failed] = await service.listEngagements(USER, { limit: 5 });
    expect(failed?.state).toBe("failed");
    expect(failed?.failureReason).toBe("The browser worker is unreachable.");
  });

  it("rate-limits engagements: hourly cap for approvals, deferral for autonomous runs", async () => {
    await service.acceptAutomationRisk(USER, LINKEDIN_AUTOMATION_CONSENT_VERSION);
    await service.updateSettings(USER, {
      modes: { react: "autonomous" },
      engagement: {
        maxActionsPerHour: 1,
        maxActionsPerDay: 10,
        minDelaySeconds: 10,
        maxDelaySeconds: 30,
        activeHours: { start: "00:00", end: "00:00", timezone: "UTC" },
      },
    });
    const first = await service.proposeEngagement(USER, {
      kind: "reaction",
      target: "urn:li:activity:1",
    });
    expect(first.state).toBe("queued");
    // Human-like delay: random 0.5 between 10 s and 30 s = 20 s.
    expect(first.executeAfter?.toISOString()).toBe("2026-11-09T10:00:20.000Z");
    await service.tickOwner(USER);
    expect(executor.executed).toHaveLength(0); // not due yet

    now = new Date("2026-11-09T10:00:21Z");
    await service.tickOwner(USER);
    expect(executor.executed).toHaveLength(1);

    const second = await service.proposeEngagement(USER, {
      kind: "reaction",
      target: "urn:li:activity:2",
    });
    now = new Date("2026-11-09T10:05:00Z");
    await service.tickOwner(USER);
    expect(executor.executed).toHaveLength(1);
    const deferred = await store.getEngagement(USER, second.id);
    expect(deferred?.state).toBe("queued");
    expect(deferred?.failureReason).toContain("Hourly limit");
    expect(deferred!.executeAfter!.getTime()).toBeGreaterThan(
      new Date("2026-11-09T11:00:21Z").getTime(),
    );

    // The member's click is held to the same hourly limit (429).
    const manual = await service.proposeEngagement(USER, {
      kind: "comment",
      target: "urn:li:activity:3",
      text: "Great",
    });
    await service.updateSettings(USER, { modes: { comment: "approval" } });
    await expect(service.approveEngagement(USER, manual.id)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("kill switch sends queued autonomous engagements back to approval", async () => {
    await service.acceptAutomationRisk(USER, LINKEDIN_AUTOMATION_CONSENT_VERSION);
    await service.updateSettings(USER, { modes: { comment: "autonomous" } });
    const item = await service.proposeEngagement(USER, { kind: "comment", target: TARGET });
    expect(item.state).toBe("queued");
    await service.updateSettings(USER, { killSwitch: true });
    const after = await store.getEngagement(USER, item.id);
    expect(after?.state).toBe("proposed");
    now = new Date("2026-11-09T12:00:00Z");
    await service.tickOwner(USER);
    expect(executor.executed).toHaveLength(0);
  });

  it("discovery requires consent and queues proposals per mode", async () => {
    await expect(service.discover(USER, 3)).rejects.toBeInstanceOf(ConflictError);
    await service.acceptAutomationRisk(USER, LINKEDIN_AUTOMATION_CONSENT_VERSION);
    await service.updateSettings(USER, {
      modes: { comment: "manual" },
      engagement: { topics: ["Rust"] },
    });
    const result = await service.discover(USER, 3);
    expect(result.created.map((c) => c.kind)).toEqual(["reaction"]);
    expect(result.created[0]?.createdBy).toBe("nexus-prepare");
  });
});

describe("LinkedIn content routes", () => {
  let harness: ApiHarness;
  let user: Account;

  beforeEach(async () => {
    harness = await makeApi();
    user = await createAccount(harness, "linkedin-a@example.test");
  });

  afterEach(async () => {
    await harness.close();
  });

  it("guards autonomous engagement behind consent and records it", async () => {
    const refused = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/linkedin/content/settings",
      headers: user.authorization,
      payload: { modes: { comment: "autonomous" } },
    });
    expect(refused.statusCode).toBe(409);

    const noFlag = await harness.app.inject({
      method: "POST",
      url: "/api/v1/linkedin/content/consent",
      headers: user.authorization,
      payload: { version: LINKEDIN_AUTOMATION_CONSENT_VERSION },
    });
    expect(noFlag.statusCode).toBe(400);

    const accepted = await harness.app.inject({
      method: "POST",
      url: "/api/v1/linkedin/content/consent",
      headers: user.authorization,
      payload: { accepted: true, version: LINKEDIN_AUTOMATION_CONSENT_VERSION },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.consent.valid).toBe(true);

    const allowed = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/linkedin/content/settings",
      headers: user.authorization,
      payload: { modes: { comment: "autonomous" } },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().data.effectiveModes.comment).toBe("autonomous");
  });

  it("fails visibly (503) when LinkedIn is not connected, and never fakes success", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/linkedin/content/posts",
      headers: user.authorization,
      payload: { text: "Hello" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id as string;
    const publish = await harness.app.inject({
      method: "POST",
      url: `/api/v1/linkedin/content/posts/${id}/publish`,
      headers: user.authorization,
      payload: {},
    });
    expect(publish.statusCode).toBe(503);
    const posts = await harness.app.inject({
      method: "GET",
      url: "/api/v1/linkedin/content/posts",
      headers: user.authorization,
    });
    expect(posts.json().data.posts[0].state).toBe("failed");

    // Drafting without a configured model is a visible 503 too.
    const generate = await harness.app.inject({
      method: "POST",
      url: "/api/v1/linkedin/content/posts/generate",
      headers: user.authorization,
      payload: { topic: "Rust" },
    });
    expect(generate.statusCode).toBe(503);

    // No browser worker: approving an engagement fails visibly.
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/linkedin/content/consent",
      headers: user.authorization,
      payload: { accepted: true, version: LINKEDIN_AUTOMATION_CONSENT_VERSION },
    });
    const proposed = await harness.app.inject({
      method: "POST",
      url: "/api/v1/linkedin/content/engagements",
      headers: user.authorization,
      payload: { kind: "reaction", target: TARGET },
    });
    expect(proposed.statusCode).toBe(200);
    const approve = await harness.app.inject({
      method: "POST",
      url: `/api/v1/linkedin/content/engagements/${proposed.json().data.id as string}/approve`,
      headers: user.authorization,
      payload: {},
    });
    expect(approve.statusCode).toBe(503);

    const audit = await harness.app.inject({
      method: "GET",
      url: "/api/v1/linkedin/content/audit",
      headers: user.authorization,
    });
    const outcomes = (audit.json().data.events as { outcome: string }[]).map((e) => e.outcome);
    expect(outcomes).toContain("failed");
  });

  it("rejects targets that are not LinkedIn posts", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/linkedin/content/engagements",
      headers: user.authorization,
      payload: { kind: "reaction", target: "https://evil.example/post" },
    });
    expect(response.statusCode).toBe(400);
  });
});

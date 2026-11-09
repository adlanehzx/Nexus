import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LINKEDIN_CONTENT_SETTINGS,
  LINKEDIN_AUTOMATION_CONSENT_VERSION,
  LinkedInApiError,
  LinkedInClient,
  LinkedInConsentRequiredError,
  applyHashtagPolicy,
  checkEngagementRateLimit,
  effectiveLinkedInMode,
  humanLikeDelayMs,
  isWithinActiveHours,
  linkedInEngagementTargetSchema,
  mergeLinkedInContentSettings,
  upcomingPostSlots,
  withinWeeklyPostCap,
  type LinkedInAutomationConsent,
  type LinkedInContentSettings,
} from "../src/index.js";

const noConsent: LinkedInAutomationConsent = { acceptedAt: null, version: null };
const consent: LinkedInAutomationConsent = {
  acceptedAt: new Date("2026-11-01T10:00:00Z"),
  version: LINKEDIN_AUTOMATION_CONSENT_VERSION,
};

function settings(patch: Partial<LinkedInContentSettings> = {}): LinkedInContentSettings {
  return {
    ...DEFAULT_LINKEDIN_CONTENT_SETTINGS,
    ...patch,
    engagement: {
      ...DEFAULT_LINKEDIN_CONTENT_SETTINGS.engagement,
      activeHours: { start: "00:00", end: "00:00", timezone: "UTC" },
      ...patch.engagement,
    },
  };
}

describe("LinkedIn content settings and modes", () => {
  it("defaults every action to approval", () => {
    expect(DEFAULT_LINKEDIN_CONTENT_SETTINGS.modes).toEqual({
      publishPost: "approval",
      react: "approval",
      comment: "approval",
    });
  });

  it("refuses autonomous reactions or comments without consent", () => {
    expect(() =>
      mergeLinkedInContentSettings(
        DEFAULT_LINKEDIN_CONTENT_SETTINGS,
        { modes: { react: "autonomous", comment: "autonomous" } },
        noConsent,
      ),
    ).toThrow(LinkedInConsentRequiredError);
    // A consent for an older warning text does not count.
    expect(() =>
      mergeLinkedInContentSettings(
        DEFAULT_LINKEDIN_CONTENT_SETTINGS,
        { modes: { comment: "autonomous" } },
        { acceptedAt: new Date(), version: LINKEDIN_AUTOMATION_CONSENT_VERSION - 1 },
      ),
    ).toThrow(LinkedInConsentRequiredError);
  });

  it("allows autonomous posting without consent (official API) and engagement with consent", () => {
    const posted = mergeLinkedInContentSettings(
      DEFAULT_LINKEDIN_CONTENT_SETTINGS,
      { modes: { publishPost: "autonomous" } },
      noConsent,
    );
    expect(posted.modes.publishPost).toBe("autonomous");
    const engaged = mergeLinkedInContentSettings(
      posted,
      { modes: { react: "autonomous" } },
      consent,
    );
    expect(engaged.modes).toEqual({
      publishPost: "autonomous",
      react: "autonomous",
      comment: "approval",
    });
  });

  it("downgrades autonomous to approval on kill switch or missing consent, never manual", () => {
    const all = settings({
      modes: { publishPost: "autonomous", react: "autonomous", comment: "manual" },
    });
    expect(effectiveLinkedInMode(all, "publishPost", noConsent)).toBe("autonomous");
    expect(effectiveLinkedInMode(all, "react", noConsent)).toBe("approval");
    expect(effectiveLinkedInMode(all, "react", consent)).toBe("autonomous");
    const killed = { ...all, killSwitch: true };
    expect(effectiveLinkedInMode(killed, "publishPost", consent)).toBe("approval");
    expect(effectiveLinkedInMode(killed, "comment", consent)).toBe("manual");
  });

  it("validates delay bounds and timezones", () => {
    expect(() =>
      mergeLinkedInContentSettings(
        DEFAULT_LINKEDIN_CONTENT_SETTINGS,
        { engagement: { minDelaySeconds: 100, maxDelaySeconds: 10 } },
        consent,
      ),
    ).toThrow();
    expect(() =>
      mergeLinkedInContentSettings(
        DEFAULT_LINKEDIN_CONTENT_SETTINGS,
        { engagement: { activeHours: { start: "09:00", end: "18:00", timezone: "Nope/Zone" } } },
        consent,
      ),
    ).toThrow();
  });
});

describe("posting schedule and weekly cap", () => {
  it("lists slots in the configured timezone", () => {
    const slots = upcomingPostSlots(
      { daysOfWeek: [1, 3], times: ["09:00", "17:30"], timezone: "Europe/Paris" },
      new Date("2026-11-09T00:00:00Z"), // Monday
      new Date("2026-11-12T00:00:00Z"),
    );
    expect(slots.map((slot) => slot.toISOString())).toEqual([
      "2026-11-09T08:00:00.000Z",
      "2026-11-09T16:30:00.000Z",
      "2026-11-11T08:00:00.000Z",
      "2026-11-11T16:30:00.000Z",
    ]);
  });

  it("caps posts per rolling week", () => {
    const at = new Date("2026-11-10T09:00:00Z");
    const existing = [new Date("2026-11-05T09:00:00Z"), new Date("2026-11-12T09:00:00Z")];
    expect(withinWeeklyPostCap({ maxPostsPerWeek: 3, at, existing })).toBe(true);
    expect(withinWeeklyPostCap({ maxPostsPerWeek: 2, at, existing })).toBe(false);
    expect(withinWeeklyPostCap({ maxPostsPerWeek: 0, at, existing: [] })).toBe(false);
  });
});

describe("hashtag policy", () => {
  const text = "Shipping a new release today #oops with care.";
  it("strips drafter hashtags and applies the policy", () => {
    expect(applyHashtagPolicy(text, { policy: "none", fixed: [], maxPerPost: 3 }, ["x"])).toBe(
      "Shipping a new release today with care.",
    );
    expect(
      applyHashtagPolicy(
        text,
        { policy: "fixed_and_generated", fixed: ["TypeScript"], maxPerPost: 2 },
        ["#typescript", "OpenSource", "Extra"],
      ),
    ).toBe("Shipping a new release today with care.\n\n#TypeScript #OpenSource");
  });
});

describe("engagement rate limiting", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it("refuses without consent and under the kill switch", () => {
    expect(
      checkEngagementRateLimit({ settings: settings(), consent: noConsent, recent: [], now }).code,
    ).toBe("consent_missing");
    expect(
      checkEngagementRateLimit({
        settings: settings({ killSwitch: true }),
        consent,
        recent: [],
        now,
      }).code,
    ).toBe("kill_switch");
  });

  it("enforces the hourly and daily limits with a retry time", () => {
    const config = settings({
      engagement: {
        ...DEFAULT_LINKEDIN_CONTENT_SETTINGS.engagement,
        activeHours: { start: "00:00", end: "00:00", timezone: "UTC" },
        maxActionsPerHour: 2,
        maxActionsPerDay: 3,
      },
    });
    expect(
      checkEngagementRateLimit({ settings: config, consent, recent: [minutesAgo(10)], now })
        .allowed,
    ).toBe(true);
    const hourly = checkEngagementRateLimit({
      settings: config,
      consent,
      recent: [minutesAgo(50), minutesAgo(10)],
      now,
    });
    expect(hourly.code).toBe("hourly_limit");
    expect(hourly.retryAt?.toISOString()).toBe("2026-11-09T12:10:00.000Z");
    const daily = checkEngagementRateLimit({
      settings: config,
      consent,
      recent: [minutesAgo(600), minutesAgo(300), minutesAgo(120)],
      now,
    });
    expect(daily.code).toBe("daily_limit");
  });

  it("respects the active-hours window, including windows crossing midnight", () => {
    const window = { start: "09:00", end: "18:00", timezone: "Europe/Paris" };
    expect(isWithinActiveHours(window, new Date("2026-11-09T10:00:00Z"))).toBe(true);
    expect(isWithinActiveHours(window, new Date("2026-11-09T17:30:00Z"))).toBe(false);
    const night = { start: "22:00", end: "02:00", timezone: "UTC" };
    expect(isWithinActiveHours(night, new Date("2026-11-09T23:00:00Z"))).toBe(true);
    expect(isWithinActiveHours(night, new Date("2026-11-09T03:00:00Z"))).toBe(false);
    const verdict = checkEngagementRateLimit({
      settings: settings({
        engagement: { ...DEFAULT_LINKEDIN_CONTENT_SETTINGS.engagement, activeHours: window },
      }),
      consent,
      recent: [],
      now: new Date("2026-11-09T20:00:00Z"),
    });
    expect(verdict.code).toBe("outside_active_hours");
    expect(verdict.retryAt?.toISOString()).toBe("2026-11-10T08:00:00.000Z");
  });

  it("draws human-like delays inside the configured bounds", () => {
    expect(humanLikeDelayMs({ minDelaySeconds: 30, maxDelaySeconds: 90 }, () => 0)).toBe(30_000);
    expect(humanLikeDelayMs({ minDelaySeconds: 30, maxDelaySeconds: 90 }, () => 0.5)).toBe(60_000);
    expect(
      humanLikeDelayMs({ minDelaySeconds: 30, maxDelaySeconds: 90 }, () => 0.999),
    ).toBeLessThan(90_001);
  });

  it("accepts only LinkedIn post targets", () => {
    expect(linkedInEngagementTargetSchema.safeParse("urn:li:activity:123").success).toBe(true);
    expect(
      linkedInEngagementTargetSchema.safeParse(
        "https://www.linkedin.com/feed/update/urn:li:activity:123/",
      ).success,
    ).toBe(true);
    expect(linkedInEngagementTargetSchema.safeParse("https://evil.example/post").success).toBe(
      false,
    );
  });
});

describe("LinkedIn client extensions", () => {
  it("derives the author URN and exposes the HTTP status on failure", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sub: "abc123", name: "Ada" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const client = new LinkedInClient({ accessToken: "token", fetchFn });
    await expect(client.getAuthorUrn()).resolves.toBe("urn:li:person:abc123");
    const failure = await client
      .createTextPost({ authorUrn: "urn:li:person:abc123", text: "hi" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LinkedInApiError);
    expect((failure as LinkedInApiError).status).toBe(401);
  });
});

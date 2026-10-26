import { opportunityFingerprint } from "../src/fingerprint.js";
import type { CareerProfile, Opportunity, Provenance } from "../src/model.js";
import type { OpportunityKind, OpportunitySourceKind } from "../src/vocabulary.js";

/**
 * Deterministic fixtures.
 *
 * No real organisation, no real person and no real address: every identifier is
 * synthetic and every domain is `.test`, which is reserved by RFC 2606 and can
 * never resolve.
 */

export const NOW = new Date("2026-06-01T09:00:00.000Z");

export function makeProfile(overrides: Partial<CareerProfile> = {}): CareerProfile {
  const base: CareerProfile = {
    id: "11111111-1111-7111-8111-111111111111",
    userId: "22222222-2222-7222-8222-222222222222",
    headline: "Distributed systems engineer",
    summary:
      "Ten years building fault-tolerant storage systems, with a focus on consensus protocols " +
      "and the operational side of running them.",
    yearsExperience: 10,
    highestDegree: "master",
    skills: ["rust", "distributed systems", "postgresql", "kubernetes"],
    languages: [
      { code: "en", level: "fluent" },
      { code: "fr", level: "native" },
    ],
    publications: 2,
    preferences: {
      kinds: ["permanent_job", "phd"],
      locations: ["Lyon", "Remote"],
      remote: "preferred",
      languages: [{ code: "en", level: "fluent" }],
      mustHaveSkills: ["rust", "distributed systems"],
      niceToHaveSkills: ["kubernetes"],
      researchAreas: ["consensus protocols"],
      minCompensation: { currency: "EUR", minAmount: 60_000, maxAmount: null, period: "year" },
      excludedOrganizations: ["Excluded Institute"],
      noticePeriodDays: 30,
    },
    version: 3,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
  };

  return { ...base, ...overrides };
}

export function makeProvenance(
  kind: OpportunitySourceKind,
  overrides: Partial<Provenance> = {},
): Provenance {
  return {
    kind,
    url: null,
    evidence: `Observed on a ${kind} source during the test run`,
    observedAt: NOW,
    ...overrides,
  };
}

export function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const kind: OpportunityKind = overrides.kind ?? "permanent_job";
  const title = overrides.title ?? "Senior Rust engineer, distributed systems";
  const organization = overrides.organization ?? "Example Storage Cooperative";
  const location = overrides.location ?? "Lyon";
  const externalRef = overrides.externalRef ?? null;

  const base: Opportunity = {
    id: "33333333-3333-7333-8333-333333333333",
    userId: "22222222-2222-7222-8222-222222222222",
    kind,
    title,
    organization,
    location,
    remote: false,
    description:
      "We run a Rust storage engine on PostgreSQL and Kubernetes. Experience with " +
      "distributed systems and consensus protocols is required. Working language is en.",
    requirements: ["rust", "distributed systems", "5 years of experience"],
    compensation: { currency: "EUR", minAmount: 70_000, maxAmount: 85_000, period: "year" },
    postedAt: new Date("2026-05-28T00:00:00.000Z"),
    closesAt: new Date("2026-08-01T00:00:00.000Z"),
    externalRef,
    canonicalUrl: "https://careers.example.test/jobs/1",
    fingerprint: opportunityFingerprint({ kind, title, organization, location, externalRef }),
    provenance: [makeProvenance("official_site")],
    untrustedContent: true,
    createdAt: NOW,
    updatedAt: NOW,
  };

  return { ...base, ...overrides };
}

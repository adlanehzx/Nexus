import { describe, expect, it } from "vitest";
import type { UsageBucketDto } from "../src/lib/api.js";
import { groupUsage, usageCsv, usagePeriod, usageTotals } from "../src/lib/usage.js";

const bucket = (overrides: Partial<UsageBucketDto>): UsageBucketDto => ({
  day: "2026-11-04",
  model: "m",
  runs: 1,
  failedRuns: 0,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  estimatedApiCostUsd: 1,
  ...overrides,
});

describe("usage presentation", () => {
  it("keeps unknown values unknown instead of counting them as zero", () => {
    const totals = usageTotals([bucket({}), bucket({ estimatedApiCostUsd: null })]);
    expect(totals.estimatedApiCostUsd).toBeNull();
    expect(totals.cacheReadTokens).toBeNull();
    expect(totals.inputTokens).toBe(20);
  });

  it("groups UTC days into ISO weeks and months", () => {
    expect(usagePeriod("2026-11-08", "week")).toBe("2026-11-02");
    expect(usagePeriod("2026-11-02", "week")).toBe("2026-11-02");
    expect(usagePeriod("2026-11-08", "month")).toBe("2026-11");
    const groups = groupUsage([bucket({ model: "a" }), bucket({ model: "a" })], (b) => b.model);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.totals.runs).toBe(2);
  });

  it("neutralizes spreadsheet formulas in exported model names", () => {
    const csv = usageCsv([bucket({ model: "=HYPERLINK(1,2)" })]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});

import {
  formatCountdown,
  getProvenanceBadge,
  isQuotaAlertTriggered,
} from "../src/lib/usage.js";

describe("Quota & Telemetry Provenance Contracts (Mission B)", () => {
  it("formats countdown durations correctly", () => {
    const now = 1730000000000;
    // 2 hours 15 minutes in the future
    const future2h = new Date(now + (2 * 3600 + 15 * 60) * 1000).toISOString();
    expect(formatCountdown(future2h, now)).toBe("2h 15m");

    // 3 days 4 hours in the future
    const future3d = new Date(now + (3 * 86400 + 4 * 3600) * 1000).toISOString();
    expect(formatCountdown(future3d, now)).toBe("3d 4h");

    // Past reset
    const past = new Date(now - 10000).toISOString();
    expect(formatCountdown(past, now)).toBe("Reset in progress");

    // Null date
    expect(formatCountdown(null, now)).toBe("Unavailable");
  });

  it("resolves strict telemetry provenance taxonomies", () => {
    expect(getProvenanceBadge("official").label).toBe("Official");
    expect(getProvenanceBadge("provider_reported").label).toBe("Provider-Reported");
    expect(getProvenanceBadge("locally_observed").label).toBe("Locally-Observed");
    expect(getProvenanceBadge("estimated").label).toBe("Estimated");
    expect(getProvenanceBadge("unavailable").label).toBe("Unavailable");
  });

  it("accurately triggers quota alert thresholds", () => {
    expect(isQuotaAlertTriggered(15, 20)).toBe(true);
    expect(isQuotaAlertTriggered(20, 20)).toBe(true);
    expect(isQuotaAlertTriggered(21, 20)).toBe(false);
    expect(isQuotaAlertTriggered(null, 20)).toBe(false);
  });
});

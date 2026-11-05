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

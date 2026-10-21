import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, updateAdvice } from "../src/updates.js";

const v = (value: string) => {
  const parsed = parseVersion(value);
  if (parsed === undefined) throw new Error(`unparseable version in test: ${value}`);
  return parsed;
};

describe("version parsing", () => {
  it("parses common formats", () => {
    expect(parseVersion("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion(" 1.2.3 ")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.2.3-rc.1")).toMatchObject({ prerelease: "rc.1" });
    expect(parseVersion("1.2.3+build.5")).toMatchObject({ major: 1, patch: 3 });
  });

  it("returns undefined instead of throwing", () => {
    for (const bad of ["", "1.2", "abc", "1.2.3.4", null, undefined]) {
      expect(parseVersion(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("comparison", () => {
  it("orders by major, minor, patch", () => {
    expect(compareVersions(v("2.0.0"), v("1.9.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.3.0"), v("1.2.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.2.4"), v("1.2.3"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.2.3"), v("1.2.3"))).toBe(0);
  });

  it("does not compare as raw strings", () => {
    expect(compareVersions(v("1.10.0"), v("1.9.0"))).toBeGreaterThan(0);
    expect(compareVersions(v("0.1.10"), v("0.1.9"))).toBeGreaterThan(0);
  });

  it("places pre-release before release", () => {
    expect(compareVersions(v("1.2.0-rc.1"), v("1.2.0"))).toBeLessThan(0);
    expect(compareVersions(v("1.2.0"), v("1.2.0-rc.1"))).toBeGreaterThan(0);
  });
});

describe("update advice", () => {
  it("reports up-to-date without action needed", () => {
    const advice = updateAdvice("1.2.3", "1.2.3");
    expect(advice.status).toBe("a-jour");
    expect(advice.action).toBeNull();
  });

  it("reports behind and prescribes local action", () => {
    const advice = updateAdvice("1.0.0", "1.2.0");
    expect(advice.status).toBe("en-retard");
    expect(advice.action).toMatch(/host machine/);
    expect(advice.action).toContain("1.2.0");
  });

  it("recognizes worker ahead of expected version", () => {
    expect(updateAdvice("2.0.0", "1.9.0").status).toBe("en-avance");
  });

  it("does not assert when no expected version is configured", () => {
    const advice = updateAdvice("1.2.3", null);
    expect(advice.status).toBe("inconnu");
    expect(advice.action).toBeNull();
  });

  it("flags worker with unreadable version", () => {
    const advice = updateAdvice(null, "1.2.0");
    expect(advice.status).toBe("inconnu");
    expect(advice.action).toMatch(/unknown/);
  });

  it("retains raw strings for display", () => {
    expect(updateAdvice("v1.0.0", "1.2.0")).toMatchObject({
      current: "v1.0.0",
      expected: "1.2.0",
    });
  });
});

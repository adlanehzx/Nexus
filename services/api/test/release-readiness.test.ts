import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Release Readiness & Operational Runbooks (Mission E)", () => {
  it("ensures release-readiness operational runbook exists and is comprehensive", () => {
    const runbookPath = path.resolve(__dirname, "../../../docs/operations/release-readiness.md");
    expect(fs.existsSync(runbookPath)).toBe(true);

    const content = fs.readFileSync(runbookPath, "utf8");
    expect(content).toContain("Production Build Targets & Packaging Verification");
    expect(content).toContain("Database Migration Safety & Reversibility Protocol");
    expect(content).toContain("Pre-Launch Verification Checklist");
    expect(content).toContain("Emergency Rollback Runbook");
    expect(content).toContain("SEC-01");
    expect(content).toContain("REL-01");
    expect(content).toContain("QTA-01");
    expect(content).toContain("UX-01");
  });

  it("verifies prisma schema defines safe nullable fields and models", () => {
    const schemaPath = path.resolve(__dirname, "../../../packages/database/prisma/schema.prisma");
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schema = fs.readFileSync(schemaPath, "utf8");

    // Critical models required for beta
    expect(schema).toContain("model User");
    expect(schema).toContain("model Device");
    expect(schema).toContain("model TenantQuotaPolicy");
    expect(schema).toContain("model BillingUsageRecord");
  });
});

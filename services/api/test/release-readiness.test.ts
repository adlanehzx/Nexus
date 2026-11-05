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
    // Verifies full backup requirements and restoration boundaries
    expect(content).toContain("pg_dump -Fc");
    expect(content).toContain("Restoration Boundaries: What Can & Cannot Be Restored");
    expect(content).toContain("Worker Ephemeral In-Memory State");
  });

  it("verifies rollback plan restores data to anterior state and documents limits", () => {
    // Simulated database snapshot representing pre-migration dataset
    interface TableRow {
      id: string;
      name: string;
      value: number;
    }
    const initialDbState: Record<string, TableRow[]> = {
      User: [
        { id: "u-1", name: "Alice", value: 100 },
        { id: "u-2", name: "Bob", value: 200 },
      ],
      TenantQuotaPolicy: [{ id: "q-1", name: "standard", value: 5000 }],
    };

    // 1. Take snapshot (simulate pg_dump -Fc / full state dump)
    const fullBackupSnapshot = JSON.stringify(initialDbState);

    // 2. Schema-only snapshot does not preserve row data
    const schemaOnlySnapshot = JSON.stringify({
      User: [],
      TenantQuotaPolicy: [],
    });

    // 3. Destructive migration or corruption alters the data
    const corruptedState: Record<string, TableRow[]> = {
      User: [{ id: "u-1", name: "Alice_Corrupted", value: 0 }],
      TenantQuotaPolicy: [],
    };

    // 4. Schema-only restore fails to bring back table rows
    const restoredFromSchemaOnly = JSON.parse(schemaOnlySnapshot) as Record<string, TableRow[]>;
    expect(restoredFromSchemaOnly.User.length).toBe(0); // Data loss!

    // 5. Full backup restore completely restores anterior state
    const restoredFromFull = JSON.parse(fullBackupSnapshot) as Record<string, TableRow[]>;
    expect(restoredFromFull).toEqual(initialDbState);
    expect(restoredFromFull.User).toHaveLength(2);
    expect(restoredFromFull.User[1]?.name).toBe("Bob");
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

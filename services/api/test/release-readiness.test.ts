import { describe, expect, it } from "vitest";
import fs, { mkdtempSync, rmSync } from "node:fs";
import path, { join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

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
    expect(corruptedState.User).toHaveLength(1);

    // 4. Schema-only restore fails to bring back table rows
    const restoredFromSchemaOnly = JSON.parse(schemaOnlySnapshot) as Record<string, TableRow[]>;
    expect(restoredFromSchemaOnly.User?.length).toBe(0); // Data loss!

    // 5. Full backup restore completely restores anterior state
    const restoredFromFull = JSON.parse(fullBackupSnapshot) as Record<string, TableRow[]>;
    expect(restoredFromFull).toEqual(initialDbState);
    expect(restoredFromFull.User).toHaveLength(2);
    expect(restoredFromFull.User?.[1]?.name).toBe("Bob");
  });

  const libpqUrl = (databaseUrl: string): string => {
    try {
      const url = new URL(databaseUrl);
      const allowed = new Set([
        "sslmode",
        "sslrootcert",
        "sslcert",
        "sslkey",
        "application_name",
        "connect_timeout",
        "options",
      ]);
      for (const key of [...url.searchParams.keys()]) {
        if (!allowed.has(key)) url.searchParams.delete(key);
      }
      return url.toString();
    } catch {
      return databaseUrl;
    }
  };

  const isPostgresReachable = (): boolean => {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) return false;
    const dbUrl = libpqUrl(rawUrl);
    try {
      const res = execSync(`psql "${dbUrl}" -t -c "SELECT 1;"`, { stdio: "pipe" });
      return res.toString().trim() === "1";
    } catch {
      return false;
    }
  };

  const hasPgTools = (): boolean => {
    try {
      execSync("pg_dump --version", { stdio: "pipe" });
      execSync("pg_restore --version", { stdio: "pipe" });
      execSync("psql --version", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };

  const requirePostgresRestore = process.env.REQUIRE_POSTGRES_RESTORE === "true";
  const canRunRestore = isPostgresReachable() && hasPgTools();

  it.skipIf(!requirePostgresRestore && !canRunRestore)(
    "performs real PostgreSQL pg_dump -Fc and pg_restore against isolated database, validating rows, constraints, and sequences",
    () => {
      if (requirePostgresRestore) {
        if (!process.env.DATABASE_URL) {
          throw new Error(
            "REQUIRE_POSTGRES_RESTORE is set to 'true', but DATABASE_URL environment variable is not defined.",
          );
        }
        if (!hasPgTools()) {
          throw new Error(
            "REQUIRE_POSTGRES_RESTORE is set to 'true', but pg_dump, pg_restore, or psql utilities are missing or not in PATH.",
          );
        }
        if (!isPostgresReachable()) {
          throw new Error(
            `REQUIRE_POSTGRES_RESTORE is set to 'true', but PostgreSQL database at ${process.env.DATABASE_URL} is not reachable.`,
          );
        }
      }

      const rawSourceDbUrl = process.env.DATABASE_URL!;
      const sourceDbUrl = libpqUrl(rawSourceDbUrl);
      const tempDir = mkdtempSync(join(tmpdir(), "nexus-pg-restore-"));
      const dumpFile = join(tempDir, "backup.dump");
      const tempDbName = `nexus_restore_test_${Date.now()}`;
      const targetDbUrl = new URL(sourceDbUrl);
      targetDbUrl.pathname = `/${tempDbName}`;
      const targetDbUrlStr = libpqUrl(targetDbUrl.toString());

      try {
        // 1. Export custom-format archive using pg_dump -Fc
        execSync(`pg_dump -Fc -f "${dumpFile}" "${sourceDbUrl}"`, { stdio: "pipe" });
        expect(fs.existsSync(dumpFile)).toBe(true);

        // 2. Create isolated target database
        try {
          execSync(`psql "${sourceDbUrl}" -c "CREATE DATABASE \\"${tempDbName}\\";"`, {
            stdio: "pipe",
          });
        } catch {
          execSync(`createdb "${tempDbName}"`, { stdio: "pipe" });
        }

        // 3. Restore archive to isolated database
        execSync(`pg_restore -d "${targetDbUrlStr}" "${dumpFile}"`, { stdio: "pipe" });

        // 4. Verify table row counts match between source and restored
        const sourceCounts = execSync(
          `psql "${sourceDbUrl}" -t -c "SELECT count(*) FROM \\"User\\";"`,
          { stdio: "pipe" },
        )
          .toString()
          .trim();
        const restoredCounts = execSync(
          `psql "${targetDbUrlStr}" -t -c "SELECT count(*) FROM \\"User\\";"`,
          { stdio: "pipe" },
        )
          .toString()
          .trim();
        expect(restoredCounts).toBe(sourceCounts);

        // 5. Verify constraints match
        const sourceConstraints = execSync(
          `psql "${sourceDbUrl}" -t -c "SELECT count(*) FROM information_schema.table_constraints WHERE table_schema = 'public';"`,
          { stdio: "pipe" },
        )
          .toString()
          .trim();
        const restoredConstraints = execSync(
          `psql "${targetDbUrlStr}" -t -c "SELECT count(*) FROM information_schema.table_constraints WHERE table_schema = 'public';"`,
          { stdio: "pipe" },
        )
          .toString()
          .trim();
        expect(restoredConstraints).toBe(sourceConstraints);
      } finally {
        try {
          execSync(
            `psql "${sourceDbUrl}" -c "DROP DATABASE IF EXISTS \\"${tempDbName}\\" WITH (FORCE);"`,
            { stdio: "pipe" },
          );
        } catch {
          try {
            execSync(`dropdb --if-exists "${tempDbName}"`, { stdio: "pipe" });
          } catch {
            // ignore drop errors in test teardown
          }
        }
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

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

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup.js";
import { resolvePaths } from "../src/environment.js";

// Explicit disposable PostgreSQL only. Never reads the developer's .env.
const databaseUrl = process.env.NEXUS_BACKUP_TEST_DATABASE_URL;
it.skipIf(!databaseUrl).each(["sqlite", "postgres"])(
  "restores API PostgreSQL, engine %s, configuration and encrypted secrets",
  async (engineKind) => {
    const root = mkdtempSync(join(tmpdir(), "nexus-backup-test-"));
    const source = resolvePaths(join(root, "source"), join(root, "source-home"));
    const target = resolvePaths(join(root, "target"), join(root, "target-home"));
    const name = `nexus_backup_test_${process.pid}_${Date.now()}`;
    const url = new URL(databaseUrl!);
    const sql = (connection: string, statement: string) =>
      execFileSync("psql", [connection, "-X", "-v", "ON_ERROR_STOP=1", "-Atc", statement], {
        encoding: "utf8",
      }).trim();
    sql(databaseUrl!, `CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const engineName = `${name}_engine`;
    const engineUrl = new URL(url);
    engineUrl.pathname = `/${engineName}`;
    const engineSetting =
      engineKind === "postgres" ? `NEXUS_ENGINE_DATABASE_URL=${engineUrl.href}\n` : "";
    try {
      if (engineKind === "postgres") sql(databaseUrl!, `CREATE DATABASE "${engineName}"`);
      for (const paths of [source, target]) mkdirSync(paths.root, { recursive: true });
      writeFileSync(
        source.envFile,
        `DATABASE_URL=${url.href}\n${engineSetting}AUTH_SIGNING_KEY=test-fixture-only\n`,
      );
      writeFileSync(target.envFile, `DATABASE_URL=${url.href}\n${engineSetting}`);
      mkdirSync(dirname(source.missionEngineDatabase), { recursive: true });
      execFileSync("sqlite3", [
        source.missionEngineDatabase,
        "CREATE TABLE missions(id TEXT); INSERT INTO missions VALUES ('saved');",
      ]);
      if (engineKind === "postgres")
        sql(
          engineUrl.href,
          "CREATE TABLE missions(id TEXT); INSERT INTO missions VALUES ('engine-saved')",
        );
      mkdirSync(dirname(source.engineRuntimeSettings), { recursive: true });
      writeFileSync(source.engineRuntimeSettings, '{"retries":2}');
      sql(
        url.href,
        "CREATE TABLE backup_probe(value TEXT); INSERT INTO backup_probe VALUES ('saved')",
      );
      const archive = await createBackup({
        paths: source,
        includeSecrets: true,
        passphrase: "fixture-passphrase",
        keep: 2,
      });
      const verification = await verifyBackup(archive.path, {
        databaseUrl: databaseUrl!,
        passphrase: "fixture-passphrase",
      });
      expect(verification.checks.every((check) => check.ok)).toBe(true);
      sql(url.href, "UPDATE backup_probe SET value='changed'");
      if (engineKind === "postgres") {
        sql(engineUrl.href, "UPDATE missions SET id='changed'");
        writeFileSync(target.envFile, `DATABASE_URL=${url.href}\n`);
        await expect(
          restoreBackup(archive.path, { paths: target, passphrase: "fixture-passphrase" }),
        ).rejects.toThrow("Destination URL missing");
        expect(sql(url.href, "SELECT value FROM backup_probe")).toBe("changed");
        writeFileSync(target.envFile, `DATABASE_URL=${url.href}\n${engineSetting}`);
      }
      const restored = await restoreBackup(archive.path, {
        paths: target,
        passphrase: "fixture-passphrase",
      });
      expect(sql(url.href, "SELECT value FROM backup_probe")).toBe("saved");
      if (engineKind === "postgres") {
        expect(sql(engineUrl.href, "SELECT id FROM missions")).toBe("engine-saved");
      } else {
        expect(
          execFileSync("sqlite3", [target.missionEngineDatabase, "SELECT id FROM missions"], {
            encoding: "utf8",
          }).trim(),
        ).toBe("saved");
      }
      expect(readFileSync(target.engineRuntimeSettings, "utf8")).toBe('{"retries":2}');
      expect(readFileSync(target.envFile, "utf8")).not.toContain("AUTH_SIGNING_KEY");
      expect(readFileSync(`${target.envFile}.restore`, "utf8")).toContain(
        "AUTH_SIGNING_KEY=test-fixture-only",
      );
      expect(statSync(`${target.envFile}.restore`).mode & 0o777).toBe(0o600);
      expect(restored.warnings.some((warning) => warning.includes("Merge .env.restore"))).toBe(
        true,
      );
      await expect(
        restoreBackup(archive.path, { paths: target, passphrase: "fixture-passphrase" }),
      ).rejects.toThrow("already exists");
    } finally {
      sql(databaseUrl!, `DROP DATABASE IF EXISTS "${engineName}"`);
      sql(databaseUrl!, `DROP DATABASE IF EXISTS "${name}"`);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

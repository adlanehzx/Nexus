import { describe, expect, it } from "vitest";

import {
  backupName,
  buildArchive,
  extractEntries,
  readArchive,
  rotationVictims,
  sha256,
} from "../src/archive.js";
import { containerPublishing, isVersionMismatch, libpqUrl } from "../src/backup.js";

const PASSPHRASE = "test-passphrase";

function flipByte(archive: Buffer, fromEnd: number): Buffer {
  const index = archive.length - fromEnd;
  archive.writeUInt8(archive.readUInt8(index) ^ 0xff, index);
  return archive;
}

function archiveOf(options: { passphrase?: string } = {}) {
  return buildArchive({
    entries: [
      { name: "postgres.dump", description: "db", content: Buffer.from("postgres data") },
      { name: "RESTORE.md", description: "instructions", content: Buffer.from("# Restoration") },
    ],
    nexusVersion: "1.0.0",
    origin: "/opt/nexus",
    createdAt: new Date("2026-10-20T16:00:00.000Z"),
    includesSecrets: false,
    restore: ["nexus restore <archive>"],
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
  });
}

describe("manifest", () => {
  it("remains readable without passphrase", () => {
    const { manifest } = readArchive(archiveOf({ passphrase: PASSPHRASE }));

    expect(manifest.createdAt).toBe("2026-10-20T16:00:00.000Z");
    expect(manifest.origin).toBe("/opt/nexus");
    expect(manifest.entries.map((entry) => entry.name)).toEqual(["postgres.dump", "RESTORE.md"]);
    expect(manifest.encryption?.algorithm).toBe("aes-256-gcm");
    expect(manifest.restore[0]).toContain("nexus restore");
  });

  it("reports when archive is unencrypted", () => {
    expect(readArchive(archiveOf()).manifest.encryption).toBeUndefined();
  });

  it("carries plaintext sha256 checksum for each entry", () => {
    const { manifest } = readArchive(archiveOf({ passphrase: PASSPHRASE }));
    const entry = manifest.entries[0];

    expect(entry?.sha256).toBe(sha256(Buffer.from("postgres data")));
  });

  it("rejects file lacking magic header", () => {
    expect(() => readArchive(Buffer.from("not an archive"))).toThrow(/NEXUSBK1/);
  });

  it("diagnoses truncated archive before attempting decryption", () => {
    const archive = archiveOf({ passphrase: PASSPHRASE });
    expect(() => readArchive(archive.subarray(0, 40))).toThrow(/truncated|incomplete/i);
  });
});

describe("content", () => {
  it("restores exact payload entries", () => {
    const entries = extractEntries(readArchive(archiveOf({ passphrase: PASSPHRASE })), PASSPHRASE);

    expect(entries.get("postgres.dump")?.toString()).toBe("postgres data");
    expect(entries.get("RESTORE.md")?.toString()).toBe("# Restoration");
  });

  it("operates without encryption", () => {
    const entries = extractEntries(readArchive(archiveOf()));

    expect(entries.get("postgres.dump")?.toString()).toBe("postgres data");
  });

  it("requires passphrase for encrypted archive", () => {
    expect(() => extractEntries(readArchive(archiveOf({ passphrase: PASSPHRASE })))).toThrow(
      /passphrase required/i,
    );
  });

  it("rejects incorrect passphrase", () => {
    expect(() =>
      extractEntries(readArchive(archiveOf({ passphrase: PASSPHRASE })), "wrong-passphrase"),
    ).toThrow(/incorrect|corrupted|tampered/i);
  });

  it("detects corrupted byte in encrypted payload", () => {
    const archive = flipByte(Buffer.from(archiveOf({ passphrase: PASSPHRASE })), 10);
    expect(() => extractEntries(readArchive(archive), PASSPHRASE)).toThrow(/corrupted|tampered|incorrect/i);
  });

  it("detects corrupted entry in unencrypted archive", () => {
    const archive = flipByte(Buffer.from(archiveOf()), 5);
    expect(() => extractEntries(readArchive(archive))).toThrow(/invalid digest|tampered/i);
  });
});

describe("rotation", () => {
  const names = [
    "nexus-backup-20261018T100000Z.nxbk",
    "nexus-backup-20261019T100000Z.nxbk",
    "nexus-backup-20261020T100000Z.nxbk",
  ];

  it("prunes oldest archives retaining newest", () => {
    expect(rotationVictims(names, 2)).toEqual(["nexus-backup-20261018T100000Z.nxbk"]);
    expect(rotationVictims(names, 1)).toEqual([
      "nexus-backup-20261018T100000Z.nxbk",
      "nexus-backup-20261019T100000Z.nxbk",
    ]);
    expect(rotationVictims(names, 3)).toEqual([]);
    expect(rotationVictims(names, 10)).toEqual([]);
  });

  it("ignores non-nexus archive files", () => {
    const mixed = [...names, "autre-fichier.tar.gz", "nexus-backup-mal-nomme.nxbk"];
    expect(rotationVictims(mixed, 2)).toEqual(["nexus-backup-20261018T100000Z.nxbk"]);
  });

  it("refuses to retain zero archives", () => {
    expect(() => rotationVictims(names, 0)).toThrow(/at least one/i);
  });

  it("sorts archive names chronologically", () => {
    const first = backupName(new Date("2026-10-19T10:00:00.000Z"));
    const second = backupName(new Date("2026-10-20T10:00:00.000Z"));

    expect([second, first].sort()).toEqual([first, second]);
    expect(first).toBe("nexus-backup-20261019T100000Z.nxbk");
  });
});

describe("database connection URL", () => {
  it("strips Prisma-specific parameters", () => {
    expect(libpqUrl("postgresql://u:p@127.0.0.1:15432/nexus?schema=public")).toBe(
      "postgresql://u:p@127.0.0.1:15432/nexus",
    );
    expect(libpqUrl("postgresql://u:p@h/db?schema=public&connection_limit=5&pgbouncer=true")).toBe(
      "postgresql://u:p@h/db",
    );
  });

  it("preserves libpq-supported parameters", () => {
    expect(libpqUrl("postgresql://u:p@h/db?sslmode=require&schema=public")).toBe(
      "postgresql://u:p@h/db?sslmode=require",
    );
  });
});

describe("version mismatch detection", () => {
  it("detects pg_dump server version mismatch", () => {
    expect(
      isVersionMismatch(
        "pg_dump: error: aborting because of server version mismatch\n" +
          "pg_dump: detail: server version: 17.11; pg_dump version: 16.15",
      ),
    ).toBe(true);
  });

  it("does not confuse version mismatch with other errors", () => {
    expect(isVersionMismatch('pg_dump: error: invalid URI query parameter: "schema"')).toBe(false);
    expect(isVersionMismatch("connection refused")).toBe(false);
  });

  it("discovers container publishing published port", () => {
    const listing = [
      "nexus-redis\t0.0.0.0:6379->6379/tcp",
      "nexus-postgres\t127.0.0.1:15432->5432/tcp",
      "other-container\t",
    ].join("\n");

    expect(containerPublishing(listing, 15432)).toBe("nexus-postgres");
    expect(containerPublishing(listing, 6379)).toBe("nexus-redis");
    expect(containerPublishing(listing, 5432)).toBeUndefined();
  });

  it("returns undefined when no container publishes target port", () => {
    expect(containerPublishing("", 15432)).toBeUndefined();
  });
});

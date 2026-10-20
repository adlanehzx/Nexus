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

/**
 * Format d'archive de sauvegarde.
 *
 * Ce qui est éprouvé ici est ce dont dépend la valeur d'une sauvegarde : elle
 * se relit, elle détecte une altération, et son manifeste est lisible **sans**
 * la clé. Une archive qu'on ne peut pas inspecter sans la déchiffrer est une
 * archive qu'on n'ose pas essayer — et une sauvegarde qu'on n'essaie jamais
 * n'est pas une sauvegarde.
 *
 * La rotation a sa propre section, parce que c'est le seul endroit du projet
 * qui supprime des fichiers : s'y tromper effacerait exactement ce qu'on
 * protège.
 */

const PASSPHRASE = "phrase de passe de test";

/**
 * Inverse un octet, compté depuis la fin.
 *
 * Par les accesseurs de `Buffer` plutôt que par l'index : sous
 * `noUncheckedIndexedAccess`, une lecture indexée est `number | undefined`, et
 * `readUInt8` dit la même chose sans l'ambiguïté.
 */
function flipByte(archive: Buffer, fromEnd: number): Buffer {
  const index = archive.length - fromEnd;
  archive.writeUInt8(archive.readUInt8(index) ^ 0xff, index);
  return archive;
}

function archiveOf(options: { passphrase?: string } = {}) {
  return buildArchive({
    entries: [
      { name: "postgres.dump", description: "base", content: Buffer.from("données postgres") },
      { name: "RESTORE.md", description: "instructions", content: Buffer.from("# Restauration") },
    ],
    nexusVersion: "1.0.0",
    origin: "/opt/nexus",
    createdAt: new Date("2026-10-20T16:00:00.000Z"),
    includesSecrets: false,
    restore: ["nexus restore <archive>"],
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
  });
}

describe("manifeste", () => {
  it("reste lisible sans la phrase de passe", () => {
    const { manifest } = readArchive(archiveOf({ passphrase: PASSPHRASE }));

    // Savoir ce qu'une archive contient et de quand elle date ne doit pas
    // exiger de la déchiffrer.
    expect(manifest.createdAt).toBe("2026-10-20T16:00:00.000Z");
    expect(manifest.origin).toBe("/opt/nexus");
    expect(manifest.entries.map((entry) => entry.name)).toEqual(["postgres.dump", "RESTORE.md"]);
    expect(manifest.encryption?.algorithm).toBe("aes-256-gcm");
    expect(manifest.restore[0]).toContain("nexus restore");
  });

  it("dit quand l'archive n'est pas chiffrée", () => {
    expect(readArchive(archiveOf()).manifest.encryption).toBeUndefined();
  });

  it("porte l'empreinte de chaque entrée en clair", () => {
    const { manifest } = readArchive(archiveOf({ passphrase: PASSPHRASE }));
    const entry = manifest.entries[0];

    expect(entry?.sha256).toBe(sha256(Buffer.from("données postgres")));
  });

  it("refuse un fichier qui n'est pas une archive", () => {
    expect(() => readArchive(Buffer.from("ceci n'est pas une archive"))).toThrow(/NEXUSBK1/);
  });

  it("diagnostique une archive tronquée au lieu d'échouer sur le déchiffrement", () => {
    const archive = archiveOf({ passphrase: PASSPHRASE });

    // La troncature est reconnue à la lecture du manifeste, donc avant toute
    // tentative de déchiffrement — le message nomme la cause réelle.
    expect(() => readArchive(archive.subarray(0, 40))).toThrow(/tronquée|incomplet/);
  });
});

describe("contenu", () => {
  it("rend les entrées à l'identique", () => {
    const entries = extractEntries(readArchive(archiveOf({ passphrase: PASSPHRASE })), PASSPHRASE);

    expect(entries.get("postgres.dump")?.toString()).toBe("données postgres");
    expect(entries.get("RESTORE.md")?.toString()).toBe("# Restauration");
  });

  it("fonctionne sans chiffrement", () => {
    const entries = extractEntries(readArchive(archiveOf()));

    expect(entries.get("postgres.dump")?.toString()).toBe("données postgres");
  });

  it("exige la phrase de passe d'une archive chiffrée", () => {
    expect(() => extractEntries(readArchive(archiveOf({ passphrase: PASSPHRASE })))).toThrow(
      /phrase de passe requise/,
    );
  });

  it("refuse une phrase de passe incorrecte", () => {
    expect(() =>
      extractEntries(readArchive(archiveOf({ passphrase: PASSPHRASE })), "mauvaise"),
    ).toThrow(/incorrecte|altérée/);
  });

  it("détecte un octet modifié dans la charge utile chiffrée", () => {
    const archive = flipByte(Buffer.from(archiveOf({ passphrase: PASSPHRASE })), 10);

    // C'est l'étiquette d'authentification GCM qui le voit : sans elle, on
    // restaurerait des données corrompues en croyant avoir réussi.
    expect(() => extractEntries(readArchive(archive), PASSPHRASE)).toThrow(/altérée|incorrecte/);
  });

  it("détecte une entrée altérée dans une archive en clair", () => {
    const archive = flipByte(Buffer.from(archiveOf()), 5);

    // Sans chiffrement, c'est l'empreinte qui tranche — et elle nomme l'entrée
    // fautive, ce qu'une erreur de déchiffrement ne saurait pas faire.
    expect(() => extractEntries(readArchive(archive))).toThrow(/empreinte invalide/);
  });
});

describe("rotation", () => {
  const names = [
    "nexus-backup-20261018T100000Z.nxbk",
    "nexus-backup-20261019T100000Z.nxbk",
    "nexus-backup-20261020T100000Z.nxbk",
  ];

  it("supprime les plus anciennes et garde les plus récentes", () => {
    expect(rotationVictims(names, 2)).toEqual(["nexus-backup-20261018T100000Z.nxbk"]);
    expect(rotationVictims(names, 3)).toEqual([]);
  });

  it("ne touche à rien d'autre que ses propres archives", () => {
    // La garantie qui compte : une rotation qui se tromperait de fichier
    // effacerait exactement ce qu'elle protège.
    const mixed = [...names, "notes.txt", "nexus-postgres-20261020.dump", "archive.tar.gz"];

    expect(rotationVictims(mixed, 1)).toEqual([
      "nexus-backup-20261018T100000Z.nxbk",
      "nexus-backup-20261019T100000Z.nxbk",
    ]);
  });

  it("refuse de tout supprimer", () => {
    expect(() => rotationVictims(names, 0)).toThrow(/au moins une/);
  });

  it("produit un nom trié chronologiquement", () => {
    const first = backupName(new Date("2026-10-19T10:00:00.000Z"));
    const second = backupName(new Date("2026-10-20T10:00:00.000Z"));

    // Le tri lexicographique doit coïncider avec le tri chronologique, sinon
    // la rotation supprimerait les mauvaises.
    expect([second, first].sort()).toEqual([first, second]);
    expect(first).toBe("nexus-backup-20261019T100000Z.nxbk");
  });
});

describe("URL de connexion", () => {
  it("retire les paramètres propres à Prisma", () => {
    // Le défaut rencontré en exécutant la commande : `pg_dump` refuse l'URL
    // entière dès qu'il voit `schema`, avec « invalid URI query parameter ».
    expect(libpqUrl("postgresql://u:p@127.0.0.1:15432/nexus?schema=public")).toBe(
      "postgresql://u:p@127.0.0.1:15432/nexus",
    );
    expect(libpqUrl("postgresql://u:p@h/db?schema=public&connection_limit=5&pgbouncer=true")).toBe(
      "postgresql://u:p@h/db",
    );
  });

  it("conserve les paramètres que libpq comprend", () => {
    // Liste blanche et non liste noire : un paramètre Prisma ajouté demain
    // casserait silencieusement les sauvegardes.
    expect(libpqUrl("postgresql://u:p@h/db?sslmode=require&schema=public")).toBe(
      "postgresql://u:p@h/db?sslmode=require",
    );
  });
});

describe("client PostgreSQL plus ancien que le serveur", () => {
  it("reconnaît le refus de pg_dump", () => {
    // Le cas rencontré en CI : client 16 des paquets de la distribution face à
    // un serveur 17 lancé par Docker. `pg_dump` refuse, et il a raison — le
    // format de sortie dépend de la version.
    expect(
      isVersionMismatch(
        "pg_dump: error: aborting because of server version mismatch\n" +
          "pg_dump: detail: server version: 17.11; pg_dump version: 16.15",
      ),
    ).toBe(true);
  });

  it("ne confond pas une autre erreur avec un écart de version", () => {
    expect(isVersionMismatch('pg_dump: error: invalid URI query parameter: "schema"')).toBe(false);
    expect(isVersionMismatch("connection refused")).toBe(false);
  });

  it("trouve le conteneur par le port publié, pas par son nom", () => {
    // Un nom codé en dur serait faux dès la première installation qui le
    // change ; le port publié, lui, vient de la configuration.
    const listing = [
      "nexus-redis\t0.0.0.0:6379->6379/tcp",
      "nexus-postgres\t127.0.0.1:15432->5432/tcp",
      "autre-chose\t",
    ].join("\n");

    expect(containerPublishing(listing, 15432)).toBe("nexus-postgres");
    expect(containerPublishing(listing, 6379)).toBe("nexus-redis");
    expect(containerPublishing(listing, 5432)).toBeUndefined();
  });

  it("rend undefined quand aucun conteneur ne publie ce port", () => {
    expect(containerPublishing("", 15432)).toBeUndefined();
  });
});

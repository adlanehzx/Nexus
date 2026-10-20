import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Format d'archive de sauvegarde.
 *
 * Volontairement simple et autodescriptif, plutôt qu'un `tar` chiffré : le
 * format est écrit ici en entier, se relit sans outil tiers, et son manifeste
 * voyage **en clair** — on peut donc savoir ce qu'une archive contient, de
 * quand elle date et comment la restaurer sans posséder la clé. Une sauvegarde
 * qu'on ne sait pas lire sans la déchiffrer est une sauvegarde qu'on n'ose pas
 * essayer.
 *
 * ```
 *   NEXUSBK1\n
 *   <longueur du manifeste JSON, décimal>\n
 *   <manifeste JSON>
 *   <charge utile, éventuellement chiffrée>
 * ```
 *
 * La charge utile est la concaténation des entrées, chacune précédée de sa
 * longueur dans le manifeste : aucune métadonnée n'est noyée dans le flux
 * chiffré, donc une archive tronquée se diagnostique au lieu d'échouer sur une
 * erreur de déchiffrement opaque.
 */

export const MAGIC = "NEXUSBK1";

/** Chiffrement : AES-256-GCM, clé dérivée par scrypt. */
export interface Encryption {
  algorithm: "aes-256-gcm";
  /** Sel de dérivation, en base64. */
  salt: string;
  iv: string;
  /** Étiquette d'authentification : c'est elle qui détecte une altération. */
  authTag: string;
  kdf: { name: "scrypt"; cost: number; blockSize: number; parallelization: number };
}

export interface ArchiveEntry {
  /** Chemin logique dans l'archive, par exemple `postgres.dump`. */
  name: string;
  bytes: number;
  /** SHA-256 du contenu **en clair**. */
  sha256: string;
  /** Ce que l'entrée apporte, pour qui lit le manifeste sans le code. */
  description: string;
}

export interface Manifest {
  format: typeof MAGIC;
  createdAt: string;
  /** Version de NEXUS au moment de la sauvegarde. */
  nexusVersion: string;
  /** Racine d'origine : utile pour comprendre une archive retrouvée plus tard. */
  origin: string;
  entries: ArchiveEntry[];
  encryption?: Encryption;
  /**
   * Les secrets sont-ils inclus ?
   *
   * Faux par défaut, et c'est une décision, pas un oubli : une archive circule,
   * se copie sur un disque externe, s'envoie. Y mettre la clé de signature
   * ferait de chaque copie un équivalent du serveur. `RESTORE.md` explique
   * alors comment rétablir les secrets à la main.
   */
  includesSecrets: boolean;
  /** Instructions de restauration, lisibles sans déchiffrer l'archive. */
  restore: string[];
}

const KDF = { name: "scrypt", cost: 2 ** 15, blockSize: 8, parallelization: 1 } as const;

export const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: KDF.cost,
    r: KDF.blockSize,
    p: KDF.parallelization,
    // Par défaut `scryptSync` refuse un coût élevé faute de mémoire autorisée.
    maxmem: 256 * 1024 * 1024,
  });
}

export interface BuildInput {
  entries: { name: string; description: string; content: Buffer }[];
  nexusVersion: string;
  origin: string;
  createdAt: Date;
  includesSecrets: boolean;
  restore: string[];
  /** Absente, l'archive n'est pas chiffrée — et le manifeste le dit. */
  passphrase?: string;
}

export function buildArchive(input: BuildInput): Buffer {
  const payload = Buffer.concat(input.entries.map((entry) => entry.content));

  const manifest: Manifest = {
    format: MAGIC,
    createdAt: input.createdAt.toISOString(),
    nexusVersion: input.nexusVersion,
    origin: input.origin,
    includesSecrets: input.includesSecrets,
    restore: input.restore,
    entries: input.entries.map((entry) => ({
      name: entry.name,
      bytes: entry.content.length,
      sha256: sha256(entry.content),
      description: entry.description,
    })),
  };

  let body = payload;
  if (input.passphrase !== undefined) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(input.passphrase, salt), iv);
    body = Buffer.concat([cipher.update(payload), cipher.final()]);
    manifest.encryption = {
      algorithm: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      kdf: KDF,
    };
  }

  const header = Buffer.from(`${MAGIC}\n`, "utf8");
  const manifestJson = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const length = Buffer.from(`${manifestJson.length}\n`, "utf8");
  return Buffer.concat([header, length, manifestJson, body]);
}

export interface ReadArchive {
  manifest: Manifest;
  /** Charge utile brute : encore chiffrée si le manifeste l'indique. */
  body: Buffer;
}

/** Lit l'en-tête et le manifeste. Ne déchiffre rien : c'est le point. */
export function readArchive(archive: Buffer): ReadArchive {
  const text = archive.subarray(0, 4096).toString("utf8");
  if (!text.startsWith(`${MAGIC}\n`)) {
    throw new Error("archive illisible : en-tête NEXUSBK1 absent");
  }
  const afterMagic = MAGIC.length + 1;
  const lengthEnd = archive.indexOf(0x0a, afterMagic);
  if (lengthEnd < 0) throw new Error("archive tronquée : longueur du manifeste absente");

  const declared = Number(archive.subarray(afterMagic, lengthEnd).toString("utf8"));
  if (!Number.isInteger(declared) || declared <= 0) {
    throw new Error("archive illisible : longueur de manifeste invalide");
  }

  const manifestStart = lengthEnd + 1;
  const manifestEnd = manifestStart + declared;
  if (archive.length < manifestEnd) throw new Error("archive tronquée : manifeste incomplet");

  const manifest = JSON.parse(
    archive.subarray(manifestStart, manifestEnd).toString("utf8"),
  ) as Manifest;
  return { manifest, body: archive.subarray(manifestEnd) };
}

/**
 * Déchiffre et découpe la charge utile en entrées.
 *
 * Chaque empreinte est vérifiée. Une entrée qui ne correspond pas interrompt
 * la lecture : restaurer la moitié d'une sauvegarde est pire que de refuser —
 * on croirait avoir restauré.
 */
export function extractEntries(read: ReadArchive, passphrase?: string): Map<string, Buffer> {
  const { manifest } = read;
  let payload = read.body;

  if (manifest.encryption !== undefined) {
    if (passphrase === undefined) {
      throw new Error("archive chiffrée : phrase de passe requise");
    }
    const { salt, iv, authTag } = manifest.encryption;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(passphrase, Buffer.from(salt, "base64")),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    try {
      payload = Buffer.concat([decipher.update(payload), decipher.final()]);
    } catch {
      // GCM ne distingue pas une mauvaise clé d'une archive altérée : le dire
      // ainsi évite de faire chercher un mot de passe quand le fichier est
      // corrompu, et l'inverse.
      throw new Error("déchiffrement refusé : phrase de passe incorrecte, ou archive altérée");
    }
  }

  const entries = new Map<string, Buffer>();
  let offset = 0;
  for (const entry of manifest.entries) {
    const content = payload.subarray(offset, offset + entry.bytes);
    if (content.length !== entry.bytes) {
      throw new Error(`archive tronquée : ${entry.name} incomplète`);
    }
    const digest = sha256(content);
    if (digest !== entry.sha256) {
      throw new Error(`empreinte invalide pour ${entry.name} : archive altérée`);
    }
    entries.set(entry.name, content);
    offset += entry.bytes;
  }
  return entries;
}

/**
 * Sélectionne les archives à supprimer pour n'en garder que `keep`.
 *
 * Rend la liste plutôt que de supprimer : l'appelant décide, et la règle se
 * teste sans toucher à un disque. Seuls les noms produits par `nexus backup`
 * sont candidats — une rotation qui se tromperait de fichier effacerait
 * exactement ce qu'elle est censée protéger.
 */
export const BACKUP_NAME = /^nexus-backup-\d{8}T\d{6}Z\.nxbk$/;

export function rotationVictims(names: string[], keep: number): string[] {
  const ours = names.filter((name) => BACKUP_NAME.test(name)).sort();
  if (keep < 1) throw new Error("la rotation doit conserver au moins une archive");
  return ours.slice(0, Math.max(0, ours.length - keep));
}

export function backupName(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `nexus-backup-${stamp}.nxbk`;
}

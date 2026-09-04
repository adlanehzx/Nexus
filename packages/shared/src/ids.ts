import { randomUUID, randomFillSync } from "node:crypto";

/**
 * UUID v7 — identifiant trié par le temps.
 *
 * Choisi comme clé primaire dans tout le modèle de données : contrairement à
 * l'UUID v4, il préserve la localité d'insertion (index B-tree qui ne se
 * fragmente pas), tout en restant non devinable et généré côté application.
 *
 * Format (RFC 9562) :
 *   48 bits  timestamp Unix en millisecondes
 *    4 bits  version (0b0111)
 *   12 bits  aléatoire
 *    2 bits  variant (0b10)
 *   62 bits  aléatoire
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  // 48 bits de timestamp, big-endian, sur les octets 0..5.
  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  // Version 7 sur les 4 bits de poids fort de l'octet 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Variant RFC 4122 sur les 2 bits de poids fort de l'octet 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Extrait l'horodatage encodé dans un UUID v7. */
export function uuidv7Timestamp(id: string): number {
  const hex = id.replace(/-/g, "").slice(0, 12);
  return Number(BigInt("0x" + hex));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Identifiant de corrélation d'une requête. Traverse toute la chaîne — HTTP,
 * job, run agent, exécution d'outil, événement WebSocket — et apparaît dans
 * chaque log. Une seule recherche donne l'histoire complète d'une demande.
 */
export function newCorrelationId(): string {
  return randomUUID();
}

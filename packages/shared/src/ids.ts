/**
 * Identifiants NEXUS.
 *
 * ## Pourquoi l'aléa passe par la Web Crypto API
 *
 * Ce fichier est importé par **tout** : le cœur sous Node, le client Windows
 * dans une WebView Tauri, l'exécutant Android sous Hermes. Il a longtemps
 * importé `node:crypto`, ce qui marchait sous Node et **échouait en silence
 * ailleurs** : Vite externalise le module vers un objet vide, si bien que
 * `randomFillSync` devenait `undefined` et que le premier identifiant généré
 * levait un `TypeError` — dans le paquet livré, pas au build.
 *
 * `globalThis.crypto.getRandomValues` est la seule source d'aléa
 * cryptographique disponible partout à la fois :
 *
 *   Node ≥ 18   `crypto` est global, sans import
 *   navigateur  natif
 *   Tauri       natif (WebView2)
 *   Hermes      absent → l'hôte Android l'installe depuis son adaptateur natif,
 *               adossé à `java.security.SecureRandom` (voir `services/android-worker/shim`)
 *
 * Aucun repli sur `Math.random` : sa suite se prédit à partir de quelques
 * observations, et ces octets deviennent des identifiants de session et de
 * requête. Mieux vaut un échec net qu'un identifiant devinable.
 */

/**
 * Octets aléatoires cryptographiques.
 *
 * Résolue à chaque appel plutôt que capturée au chargement du module : sur
 * Hermes, l'hôte installe `globalThis.crypto` au démarrage de l'application,
 * qui peut suivre l'évaluation de ce module.
 */
interface RandomSource {
  getRandomValues<T extends Uint8Array>(into: T): T;
}

function randomBytes(count: number): Uint8Array {
  // Type structurel plutôt que `Crypto` du DOM : ce paquet compile avec
  // `lib: ES2023` et `types: ["node"]`, sans bibliothèque de navigateur.
  const source = (globalThis as { crypto?: Partial<RandomSource> }).crypto;

  if (source?.getRandomValues === undefined) {
    throw new Error(
      "Aucune source d'aléa cryptographique : globalThis.crypto.getRandomValues est absent. " +
        "Sous Node, exigez la version 18 ou plus récente ; sur un moteur embarqué, installez " +
        "la Web Crypto API avant de charger @nexus/shared.",
    );
  }

  return source.getRandomValues(new Uint8Array(count));
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/** Rend les octets en hexadécimal, sans passer par `Buffer` — absent du navigateur. */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte];
  return out;
}

/** Découpe 32 caractères hexadécimaux selon la forme canonique 8-4-4-4-12. */
function format(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

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
  const bytes = randomBytes(16);

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

  return format(toHex(bytes));
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
 *
 * UUID v4, et non v7 : un identifiant de corrélation ne sert jamais de clé
 * primaire, donc la localité d'insertion n'a pas d'intérêt ici, et n'y encoder
 * aucun horodatage évite de publier une heure dans chaque en-tête de réponse.
 *
 * `crypto.randomUUID()` n'est volontairement pas utilisé : il exige un contexte
 * sécurisé dans un navigateur, ce que le schéma `tauri://` ne garantit pas.
 */
export function newCorrelationId(): string {
  const bytes = randomBytes(16);

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return format(toHex(bytes));
}

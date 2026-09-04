import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { AppError, type ErrorSeverity } from "@nexus/shared";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Hachage de mots de passe.
 *
 * `scrypt`, disponible dans Node sans dépendance. Le choix face à bcrypt tient
 * à une propriété précise : scrypt est coûteux en **mémoire** autant qu'en
 * temps, ce qui rend une attaque par matériel dédié bien plus chère — c'est
 * exactement la menace contre un fichier de hachages dérobé.
 *
 * Les paramètres sont inscrits **dans l'empreinte**. Les durcir plus tard ne
 * cassera pas les mots de passe existants : chaque hachage se relit avec les
 * paramètres qui l'ont produit, et `needsRehash` signale ceux à recalculer à la
 * prochaine connexion réussie.
 */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/**
 * Paramètres de production. `N = 2^16` coûte environ 350 ms par appel.
 *
 * C'est le but : le coût est ce qui rend une attaque hors ligne pénible.
 */
export const SCRYPT_INTERACTIVE: ScryptParams = { N: 65_536, r: 8, p: 1 };

/**
 * Paramètres réduits, **pour les tests uniquement**.
 *
 * Une suite de tests qui paie 350 ms par compte créé devient inutilisable, et
 * une suite lente finit par ne plus être lancée. Les paramètres étant inscrits
 * dans l'empreinte, un hachage produit ici se relit normalement — et
 * `needsRehash` le signalera comme à recalculer, ce qui est exact.
 *
 * Ne jamais utiliser en production : `N = 2^12` se force en quelques heures sur
 * du matériel ordinaire.
 */
export const SCRYPT_FAST: ScryptParams = { N: 4_096, r: 8, p: 1 };

const CURRENT = SCRYPT_INTERACTIVE;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Plafond mémoire passé à scrypt.
 *
 * L'algorithme exige `128 · N · r` octets. La marge est faible et délibérée :
 * `maxmem` n'est pas une réservation, mais un plafond que Node vérifie, et
 * l'annoncer bien au-dessus du nécessaire allonge sensiblement l'appel sans rien
 * apporter. Le plancher d'un mégaoctet couvre les paramètres réduits des tests.
 */
const memoryFor = (params: ScryptParams): number => Math.max(1 << 20, 144 * params.N * params.r);

export class PasswordTooWeakError extends AppError {
  readonly code = "PASSWORD_TOO_WEAK";
  readonly httpStatus = 400;
  override readonly severity: ErrorSeverity = "warning";

  constructor(reason: string) {
    super({
      message: `Mot de passe refusé : ${reason}`,
      userMessage: `Mot de passe refusé : ${reason}`,
      // Le mot de passe lui-même n'entre nulle part dans l'erreur.
      context: { reason },
    });
  }
}

/**
 * Exigence minimale : douze caractères.
 *
 * Volontairement une seule règle, et sur la longueur. Les règles de composition
 * — une majuscule, un chiffre, un symbole — poussent à `Motdepasse1!` et
 * réduisent l'espace de recherche au lieu de l'élargir.
 */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < 12) {
    throw new PasswordTooWeakError("il doit faire au moins 12 caractères");
  }
  if (password.length > 1_024) {
    // Sans borne haute, une chaîne d'un mégaoctet ferait travailler scrypt
    // pendant des secondes — un déni de service à coût nul pour l'attaquant.
    throw new PasswordTooWeakError("il ne peut pas dépasser 1024 caractères");
  }
}

/**
 * Empreinte au format `scrypt$N$r$p$sel$clé`, paramètres inclus.
 *
 * `params` n'existe que pour les tests. En production, le défaut s'applique.
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = CURRENT,
): Promise<string> {
  assertPasswordAcceptable(password);

  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    ...params,
    maxmem: memoryFor(params),
  });

  return [
    "scrypt",
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Vérifie un mot de passe.
 *
 * Retourne `false` plutôt que de lever sur une empreinte illisible : un
 * enregistrement corrompu ne doit pas produire une erreur différente d'un
 * mauvais mot de passe, sans quoi la réponse elle-même renseigne un attaquant.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (parsed === undefined) return false;

  try {
    const derived = await scrypt(password, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: memoryFor(parsed),
    });

    return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
  } catch {
    return false;
  }
}

/** L'empreinte a-t-elle été produite avec des paramètres dépassés ? */
export function needsRehash(encoded: string): boolean {
  const parsed = parseHash(encoded);
  if (parsed === undefined) return true;

  return parsed.N < CURRENT.N || parsed.r < CURRENT.r || parsed.p < CURRENT.p;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(encoded: string): ParsedHash | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;

  const N = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined;

  // Borne les paramètres relus : une empreinte falsifiée annonçant `N = 2^30`
  // ferait épuiser la mémoire du serveur à la première tentative de connexion.
  if (N > 1 << 18 || r > 16 || p > 16) return undefined;

  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(parts[4] ?? "", "base64url"),
      key: Buffer.from(parts[5] ?? "", "base64url"),
    };
  } catch {
    return undefined;
  }
}

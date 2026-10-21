import path from "node:path";
import { PathNotAllowedError } from "../errors.js";

/**
 * Politique de chemins.
 *
 * Le worker n'a **pas** accès au disque : il a accès à une liste de racines
 * déclarées. Tout le reste est refusé, y compris ce qui n'existe pas encore —
 * un chemin d'écriture est vérifié avant d'être créé.
 *
 * Windows impose des vérifications qu'un portage naïf depuis POSIX oublie :
 *
 *  - la comparaison de chemins est **insensible à la casse** (`C:\Users` et
 *    `c:\users` désignent la même chose) ;
 *  - les **flux de données alternatifs** (`fichier.txt:secret`) permettent de
 *    lire à côté du fichier qu'on croit avoir autorisé ;
 *  - les **noms de périphériques réservés** (`CON`, `NUL`, `COM1`…) résolvent
 *    vers du matériel, pas vers des fichiers ;
 *  - les préfixes `\\?\` et `\\.\` contournent la normalisation du système ;
 *  - un **chemin UNC** (`\\serveur\partage`) sort de la machine entièrement.
 *
 * Enfin, la comparaison porte sur le chemin **résolu** : un lien symbolique ou
 * une jonction placés dans un dossier autorisé pointeraient sinon n'importe où.
 */

/** Résout les liens. Injectable : les tests n'ont pas à créer de jonctions. */
export type RealPathResolver = (candidate: string) => Promise<string>;

export interface PathPolicyOptions {
  /** Racines autorisées. Une liste vide interdit tout. */
  allowedRoots: readonly string[];
  /** Chemins refusés même s'ils tombent sous une racine autorisée. */
  deniedPaths?: readonly string[];
  /**
   * Segments refusés où qu'ils apparaissent, en plus de ceux codés en dur.
   *
   * Les refus intégrés couvrent les secrets du système ; ceux-ci viennent de la
   * politique locale, donc de l'utilisateur, qui seul sait que son dossier
   * `~/clients` ne doit jamais être lu.
   */
  deniedSegments?: readonly string[];
  /**
   * Noms de fichiers refusés, avec au plus une `*` en fin.
   *
   * C'est le cas que les refus par dossier ne couvrent pas : un `.env` traîne
   * dans *chaque* projet, sous une racine qu'on veut par ailleurs autoriser.
   */
  deniedNames?: readonly string[];
  /**
   * Résolution des liens. Par défaut, `fs.realpath` avec repli sur le parent
   * existant — un fichier à créer n'a pas encore de chemin réel.
   */
  realpath?: RealPathResolver;
}

/**
 * Emplacements refusés quoi qu'il arrive.
 *
 * Ce ne sont pas des suggestions. Même si l'utilisateur autorise `C:\` par
 * mégarde, ces chemins restent fermés : ils contiennent les identifiants du
 * système, les clés SSH, les jetons de session des navigateurs, les magasins de
 * mots de passe. Une capacité `filesystem.read` accordée pour lire des projets
 * ne doit jamais permettre d'exfiltrer une base SAM.
 */
export const ALWAYS_DENIED = [
  "C:\\Windows\\System32\\config",
  "C:\\Windows\\System32\\drivers\\etc",
  "C:\\Windows\\repair",
  "C:\\ProgramData\\Microsoft\\Crypto",
] as const;

/** Fragments refusés partout dans un chemin, quelle que soit la racine. */
const DENIED_SEGMENTS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".npmrc",
  ".git-credentials",
  "credentials",
  "id_rsa",
  "id_ed25519",
];

/** Noms de périphériques Windows : ils ne désignent pas des fichiers. */
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.[^.]*)?$/i;

export class PathPolicy {
  readonly #roots: string[];
  readonly #denied: string[];
  readonly #deniedSegments: string[];
  readonly #deniedNames: string[];
  readonly #realpath: RealPathResolver;

  constructor(options: PathPolicyOptions) {
    this.#roots = options.allowedRoots.map(normalize);
    this.#denied = [...ALWAYS_DENIED, ...(options.deniedPaths ?? [])].map(normalize);
    // Les refus de la politique s'**ajoutent** à ceux intégrés : une politique
    // locale peut fermer davantage, jamais ouvrir ce que le worker refuse de
    // lui-même. C'est ce qui permet de la laisser éditer sans crainte.
    this.#deniedSegments = [
      ...DENIED_SEGMENTS,
      ...(options.deniedSegments ?? []).map((segment) => segment.toLowerCase()),
    ];
    this.#deniedNames = (options.deniedNames ?? []).map((name) => name.toLowerCase());
    this.#realpath = options.realpath ?? ((candidate) => Promise.resolve(candidate));
  }

  get roots(): readonly string[] {
    return this.#roots;
  }

  /**
   * Valide un chemin et renvoie sa forme absolue résolue.
   *
   * @throws {PathNotAllowedError} dès qu'un doute subsiste. La politique ne
   *   cherche pas à deviner l'intention : ce qui n'est pas manifestement dans
   *   une racine autorisée est refusé.
   */
  async resolve(requested: string): Promise<string> {
    const raw = requested.trim();
    if (raw.length === 0) throw new PathNotAllowedError(requested, "chemin vide");

    // Le caractère nul tronque les chaînes dans les appels système sous-jacents :
    // "autorisé\0/../../secret" passerait la vérification et lirait autre chose.
    if (raw.includes("\0")) throw new PathNotAllowedError(requested, "caractère nul");

    if (raw.startsWith("\\\\?\\") || raw.startsWith("\\\\.\\")) {
      throw new PathNotAllowedError(requested, "préfixe de chemin étendu");
    }
    if (raw.startsWith("\\\\") || raw.startsWith("//")) {
      throw new PathNotAllowedError(requested, "chemin réseau UNC");
    }

    if (this.#roots.length === 0) {
      throw new PathNotAllowedError(requested, "aucune racine autorisée n'est configurée");
    }

    // Un chemin relatif serait résolu contre le répertoire courant du worker,
    // qui n'a aucune raison d'être une racine autorisée.
    if (!path.win32.isAbsolute(raw) && !path.posix.isAbsolute(raw)) {
      throw new PathNotAllowedError(requested, "chemin relatif");
    }

    const absolute = normalize(raw);

    for (const segment of absolute.split(/[\\/]/)) {
      if (segment.includes(":")) {
        // Le premier segment porte légitimement la lettre de lecteur ; ailleurs,
        // un « : » ouvre un flux de données alternatif.
        if (segment !== absolute.split(/[\\/]/)[0]) {
          throw new PathNotAllowedError(requested, "flux de données alternatif");
        }
      }
      if (RESERVED_NAMES.test(segment)) {
        throw new PathNotAllowedError(requested, "nom de périphérique réservé");
      }
    }

    // Résolution des liens **avant** la comparaison : c'est tout l'intérêt.
    const resolved = normalize(await this.#realpath(absolute));

    for (const denied of this.#denied) {
      if (isWithin(resolved, denied)) {
        throw new PathNotAllowedError(requested, "emplacement système protégé");
      }
    }

    const lowered = resolved.toLowerCase();
    const segments = lowered.split(/[\\/]/);
    for (const segment of this.#deniedSegments) {
      if (segments.includes(segment)) {
        throw new PathNotAllowedError(requested, "emplacement contenant des secrets");
      }
    }

    const name = segments.at(-1) ?? "";
    for (const pattern of this.#deniedNames) {
      const matches = pattern.endsWith("*")
        ? name.startsWith(pattern.slice(0, -1))
        : name === pattern;
      if (matches) {
        throw new PathNotAllowedError(requested, `nom refusé par la politique locale (${pattern})`);
      }
    }

    if (!this.#roots.some((root) => isWithin(resolved, root))) {
      throw new PathNotAllowedError(requested, "hors des racines autorisées");
    }

    return resolved;
  }

  /** Variante non levante, pour les vérifications préalables. */
  async allows(requested: string): Promise<boolean> {
    try {
      await this.resolve(requested);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Forme canonique d'un chemin.
 *
 * `path.win32.resolve` absorbe les `..`, unifie les séparateurs et supprime les
 * segments vides. La casse est laissée telle quelle ici — la comparaison, elle,
 * l'ignore.
 */
function normalize(candidate: string): string {
  return path.win32.resolve(candidate.replace(/\//g, "\\"));
}

/**
 * `child` est-il à l'intérieur de `root` ?
 *
 * La comparaison est insensible à la casse (Windows) et se fait segment par
 * segment. Comparer des préfixes de chaînes ferait passer `C:\Projets-secrets`
 * pour un enfant de `C:\Projets`.
 */
function isWithin(child: string, root: string): boolean {
  const a = child.toLowerCase();
  const b = root.toLowerCase();
  if (a === b) return true;
  return a.startsWith(b.endsWith("\\") ? b : `${b}\\`);
}

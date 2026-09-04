import fs from "node:fs/promises";
import path from "node:path";

/**
 * Accès disque.
 *
 * Port, pour la même raison que `ProcessRunner` : les tests ne doivent écrire
 * nulle part sur la machine du développeur. Toute la politique de chemins se
 * vérifie contre une implémentation en mémoire, y compris les tentatives
 * d'évasion par lien symbolique — qu'il serait pénible de mettre en scène pour
 * de vrai, et impossible sans privilèges sous Windows.
 */

export interface FileStat {
  size: number;
  isDirectory: boolean;
  modifiedAt: string;
}

export interface FileSystemPort {
  /**
   * Chemin réel, liens résolus.
   *
   * Sur un chemin qui n'existe pas encore — cas d'une écriture — remonte au
   * premier parent existant et le résout. Sinon, créer un fichier serait
   * impossible à autoriser.
   */
  realpath(candidate: string): Promise<string>;
  readFile(absolutePath: string, maxBytes: number): Promise<string>;
  writeFile(absolutePath: string, content: string, append: boolean): Promise<number>;
  stat(absolutePath: string): Promise<FileStat | undefined>;
  ensureDirectory(absolutePath: string): Promise<void>;
}

export class NodeFileSystem implements FileSystemPort {
  async realpath(candidate: string): Promise<string> {
    let current = candidate;
    const suffixes: string[] = [];

    // On remonte jusqu'au premier parent existant, puis on le résout et on
    // recolle la queue. Un lien symbolique placé sur un dossier parent est ainsi
    // détecté même si la cible n'existe pas encore.
    for (let depth = 0; depth < 64; depth += 1) {
      try {
        const real = await fs.realpath(current);
        return suffixes.length === 0 ? real : path.win32.join(real, ...suffixes.reverse());
      } catch {
        const parent = path.win32.dirname(current);
        if (parent === current) return candidate;
        suffixes.push(path.win32.basename(current));
        current = parent;
      }
    }

    return candidate;
  }

  async readFile(absolutePath: string, maxBytes: number): Promise<string> {
    const handle = await fs.open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async writeFile(absolutePath: string, content: string, append: boolean): Promise<number> {
    await fs.mkdir(path.win32.dirname(absolutePath), { recursive: true });
    if (append) await fs.appendFile(absolutePath, content, "utf8");
    else await fs.writeFile(absolutePath, content, "utf8");
    return Buffer.byteLength(content, "utf8");
  }

  async stat(absolutePath: string): Promise<FileStat | undefined> {
    try {
      const stats = await fs.stat(absolutePath);
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        modifiedAt: stats.mtime.toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  async ensureDirectory(absolutePath: string): Promise<void> {
    await fs.mkdir(absolutePath, { recursive: true });
  }
}

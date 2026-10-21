import { z } from "zod";
import { redactText } from "@nexus/shared";
import type { LocalCapability } from "@nexus/worker-core";
import type { PathPolicy } from "../policy/path-policy.js";
import type { FileSystemPort } from "../runtime/file-system.js";
import { PolicyViolationError } from "../errors.js";

/**
 * `filesystem.read` et `filesystem.write`.
 *
 * Chaque chemin traverse `PathPolicy` avant le moindre appel système — y compris
 * en écriture, où le fichier n'existe pas encore. La vérification porte sur le
 * chemin **résolu**, liens compris : un raccourci déposé dans un dossier
 * autorisé ne donne pas accès à sa cible.
 *
 * La lecture est bornée en taille. Sans borne, `filesystem.read` sur un fichier
 * de plusieurs gigaoctets saturerait la mémoire du worker et celle du cœur, puis
 * finirait dans une fenêtre de contexte.
 */

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;

export const readInputSchema = z.object({
  path: z.string().min(1).max(4_096),
  /** Octets lus au maximum. Au-delà, le contenu est tronqué, jamais refusé. */
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_BYTES)
    .default(64 * 1024),
});

export const writeInputSchema = z.object({
  path: z.string().min(1).max(4_096),
  content: z.string().max(MAX_WRITE_BYTES),
  /** Ajouter à la fin plutôt qu'écraser. */
  append: z.boolean().default(false),
  /**
   * Écraser un fichier existant.
   *
   * Faux par défaut : une écriture qui détruit silencieusement un fichier est
   * exactement le genre d'action qu'un agent ne doit pas pouvoir déclencher par
   * inadvertance.
   */
  overwrite: z.boolean().default(false),
});

export type ReadInput = z.infer<typeof readInputSchema>;
export type WriteInput = z.infer<typeof writeInputSchema>;

export interface ReadResult {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface WriteResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export interface FileSystemDependencies {
  pathPolicy: PathPolicy;
  fileSystem: FileSystemPort;
}

export function createFilesystemReadCapability(
  dependencies: FileSystemDependencies,
): LocalCapability<ReadInput, ReadResult> {
  return {
    name: "filesystem.read",
    description: "Lit un fichier situé dans un dossier autorisé de cet ordinateur.",
    inputSchema: readInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Chemin absolu du fichier" },
        maxBytes: { type: "number", description: "Taille maximale lue" },
      },
      required: ["path"],
    },
    riskLevel: "SAFE",

    execute: async (input): Promise<ReadResult> => {
      const resolved = await dependencies.pathPolicy.resolve(input.path);
      const stats = await dependencies.fileSystem.stat(resolved);

      if (stats === undefined) {
        throw new PolicyViolationError({
          rule: "filesystem.missing",
          message: "Fichier introuvable",
          userMessage: "Ce fichier n'existe pas.",
          context: { path: resolved },
        });
      }
      if (stats.isDirectory) {
        throw new PolicyViolationError({
          rule: "filesystem.directory",
          message: "Le chemin désigne un dossier",
          userMessage: "Ce chemin est un dossier, pas un fichier.",
          context: { path: resolved },
        });
      }

      const content = await dependencies.fileSystem.readFile(resolved, input.maxBytes);

      // Un fichier lu peut être un `.env`, un fichier de configuration, un
      // journal applicatif. La rédaction s'applique donc au contenu lui-même —
      // c'est le seul endroit où l'on puisse encore l'intercepter.
      return {
        path: resolved,
        content: redactText(content),
        bytes: stats.size,
        truncated: stats.size > input.maxBytes,
      };
    },
  };
}

export function createFilesystemWriteCapability(
  dependencies: FileSystemDependencies,
): LocalCapability<WriteInput, WriteResult> {
  return {
    name: "filesystem.write",
    description: "Écrit un fichier dans un dossier autorisé de cet ordinateur.",
    inputSchema: writeInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Chemin absolu du fichier" },
        content: { type: "string", description: "Contenu à écrire" },
        append: { type: "boolean", description: "Ajouter à la fin" },
        overwrite: { type: "boolean", description: "Autoriser l'écrasement" },
      },
      required: ["path", "content"],
    },
    riskLevel: "MEDIUM",

    execute: async (input): Promise<WriteResult> => {
      const resolved = await dependencies.pathPolicy.resolve(input.path);
      const existing = await dependencies.fileSystem.stat(resolved);

      if (existing?.isDirectory === true) {
        throw new PolicyViolationError({
          rule: "filesystem.directory",
          message: "Le chemin désigne un dossier",
          userMessage: "That path is a directory; a file cannot be written there.",
          context: { path: resolved },
        });
      }

      if (existing !== undefined && !input.overwrite && !input.append) {
        throw new PolicyViolationError({
          rule: "filesystem.overwrite",
          message: "Écrasement non autorisé",
          userMessage: "That file already exists. Ask explicitly to overwrite or to append.",
          context: { path: resolved },
        });
      }

      const bytesWritten = await dependencies.fileSystem.writeFile(
        resolved,
        input.content,
        input.append,
      );

      return { path: resolved, bytesWritten, created: existing === undefined };
    },
  };
}

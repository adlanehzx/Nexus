import { z } from "zod";
import { redactText } from "@nexus/shared";
import type { LocalCapability } from "@nexus/worker-core";
import type { PathPolicy } from "../policy/path-policy.js";
import type { FileSystemPort } from "../runtime/file-system.js";
import { PolicyViolationError } from "../errors.js";

/**
 * `filesystem.read` and `filesystem.write`.
 *
 * All paths are checked by `PathPolicy` prior to file operations.
 */

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;

export const readInputSchema = z.object({
  path: z.string().min(1).max(4_096),
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
  append: z.boolean().default(false),
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
    description: "Reads a file located in an allowed folder on this computer.",
    inputSchema: readInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        maxBytes: { type: "number", description: "Maximum bytes to read" },
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
          message: "File not found",
          userMessage: "This file does not exist.",
          context: { path: resolved },
        });
      }
      if (stats.isDirectory) {
        throw new PolicyViolationError({
          rule: "filesystem.directory",
          message: "Path designates a directory",
          userMessage: "This path is a directory, not a file.",
          context: { path: resolved },
        });
      }

      const content = await dependencies.fileSystem.readFile(resolved, input.maxBytes);

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
    description: "Writes a file to an allowed folder on this computer.",
    inputSchema: writeInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "Content to write" },
        append: { type: "boolean", description: "Append to end of file" },
        overwrite: { type: "boolean", description: "Allow overwriting existing file" },
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
          message: "Path designates a directory",
          userMessage: "That path is a directory; a file cannot be written there.",
          context: { path: resolved },
        });
      }

      if (existing !== undefined && !input.overwrite && !input.append) {
        throw new PolicyViolationError({
          rule: "filesystem.overwrite",
          message: "Overwriting not allowed",
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

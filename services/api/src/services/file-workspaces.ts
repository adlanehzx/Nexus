import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { AuthorizationError } from "@nexus/shared";
import { z } from "zod";
import type { RuntimeConfigurationStore } from "./runtime-configuration.js";

export const fileWorkspaceSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  label: z.string().min(1).max(100),
  root: z.string().min(1),
});
export type FileWorkspace = z.infer<typeof fileWorkspaceSchema>;
const denied = () =>
  new AuthorizationError({
    message: "Workspace path is not assigned to this user",
    userMessage: "Choose a folder authorized for your account.",
  });
const contained = (root: string, target: string) => {
  const suffix = relative(root, target);
  return (
    suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
  );
};

/** Resolve existing ancestors too, so a symlink cannot bypass checks on a new worktree. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonical(parent), relative(parent, path));
  }
}

export class FileWorkspaces {
  #entries: FileWorkspace[] = [];
  #write: Promise<unknown> = Promise.resolve();
  private readonly persistence: RuntimeConfigurationStore | undefined;
  constructor(persistence?: RuntimeConfigurationStore) {
    this.persistence = persistence;
  }

  async list(userId?: string): Promise<FileWorkspace[]> {
    const entries = this.persistence ? await this.persistence.loadFileWorkspaces() : this.#entries;
    return entries
      .filter((entry) => userId === undefined || entry.userId === userId)
      .map((entry) => ({ ...entry }));
  }

  async save(input: FileWorkspace): Promise<FileWorkspace> {
    const entry = fileWorkspaceSchema.parse(input);
    if (!isAbsolute(entry.root)) throw denied();
    const root = await realpath(entry.root);
    if (
      root === sep ||
      ["/etc", "/proc", "/sys", "/dev", "/run", "/boot"].some((base) => contained(base, root))
    )
      throw denied();
    if (!(await stat(root)).isDirectory()) throw denied();
    const saved = { ...entry, root };
    await this.#mutate((all) => [...all.filter((item) => item.id !== entry.id), saved]);
    return saved;
  }

  async remove(id: string): Promise<void> {
    await this.#mutate((all) => all.filter((item) => item.id !== id));
  }

  async #mutate(update: (entries: FileWorkspace[]) => FileWorkspace[]): Promise<void> {
    const operation = this.#write.then(async () => {
      const entries = update(await this.list());
      if (this.persistence) await this.persistence.saveFileWorkspaces(entries);
      else this.#entries = entries;
    });
    this.#write = operation.catch(() => undefined);
    await operation;
  }

  async authorizeRepository(userId: string, path: string): Promise<string> {
    const cwd = await this.authorize(userId, path);
    let common: string;
    try {
      const result = await promisify(execFile)(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd },
      );
      common = result.stdout.trim();
    } catch {
      // Non-Git directories are allowed by the snapshot service; no Git access occurs.
      return cwd;
    }
    await this.authorize(userId, common);
    return cwd;
  }

  async authorize(userId: string, path: string, workspaceId?: string): Promise<string> {
    if (!isAbsolute(path)) throw denied();
    const target = await canonical(path);
    for (const entry of await this.list(userId)) {
      if (workspaceId !== undefined && entry.id !== workspaceId) continue;
      // Fail closed if the operator-approved root itself has been replaced by a link.
      if ((await realpath(entry.root)) !== entry.root) continue;
      if (contained(entry.root, target)) return target;
    }
    throw denied();
  }
}

/** Safe Git ref component, bound to owner and client conversation without collisions. */
export function checkpointThread(userId: string, threadId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([userId, threadId]))
    .digest("hex");
}

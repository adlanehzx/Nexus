import { lstat } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Stats } from "node:fs";
import { AppError } from "@nexus/shared";

/**
 * Removing a stale Unix socket without becoming a file-deletion primitive.
 *
 * ## The problem with an unconditional unlink
 *
 * A connector that starts by deleting whatever sits at its configured path is a
 * tool for deleting that path. The configured path is usually trustworthy, but
 * "usually" is doing a lot of work: the value can come from a config file, a
 * packaging default, an environment variable or a flag, and the process may be
 * running as a service with more privilege than whoever last edited any of
 * those. Two concrete failures follow:
 *
 *  - **A symlink.** If an attacker who can write the parent directory replaces
 *    the socket path with a link to something else, an unconditional unlink
 *    removes the target instead. The link is the classic form of this; the
 *    defence is `lstat`, which describes the link rather than following it.
 *  - **A real file.** A path typo, a packaging mistake, or a config pointing at
 *    something that matters, and the connector quietly destroys it on startup.
 *
 * So removal is narrowed to the one thing that is safe to remove: an actual
 * socket. Everything else is refused, loudly, and the connector does not start.
 * Refusing to start is the correct outcome — a connector that cannot bind is a
 * missing feature, while a connector that deleted the wrong file is data loss.
 */

export class ConnectorSocketError extends AppError {
  readonly code = "CONNECTOR_SOCKET_UNSAFE";
  readonly httpStatus = 500;

  constructor(detail: string) {
    super({
      message: `connector socket path is not safe to use: ${detail}`,
      userMessage: "The connector could not start because its socket path is not usable.",
    });
  }
}

/** Describes what is at a path without following a link. Absent paths yield `undefined`. */
async function describe(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConnectorSocketError(`cannot inspect ${path}`);
  }
}

/**
 * Checks the directory the socket will live in.
 *
 * The socket's own permissions only matter if nobody else can swap the socket
 * out from under it, which is a property of the parent. Two rules:
 *
 *  - **World-writable without the sticky bit is refused.** In such a directory
 *    any local user can delete our socket and put their own there, and every
 *    client would then authenticate to them. `/tmp` is world-writable *with*
 *    the sticky bit, which is exactly the mitigation — it stops non-owners from
 *    removing our entry — so sticky directories are allowed.
 *  - **The parent must belong to us or to root.** A directory owned by another
 *    user can be replaced wholesale, which defeats the check above.
 */
/** What `assessSocketParent` needs. A subset of `Stats`, so tests can supply one. */
export interface DirectoryFacts {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  mode: number;
  uid: number;
}

/**
 * The parent-directory rules, as a pure function.
 *
 * Separated from the filesystem on purpose. The ownership rule cannot be
 * exercised against a real directory without a second user account, and a rule
 * no test can see fail is not a rule — it is a comment that happens to compile.
 * Here it is an argument, so every branch is reachable from a test.
 *
 * Returns the reason for refusing, or `undefined` when the directory is safe.
 */
export function assessSocketParent(
  facts: DirectoryFacts | undefined,
  currentUid: number | undefined,
): string | undefined {
  if (facts === undefined) return "does not exist";
  if (facts.isSymbolicLink()) return "is a symbolic link";
  if (!facts.isDirectory()) return "is not a directory";

  const worldWritable = (facts.mode & 0o002) !== 0;
  const sticky = (facts.mode & 0o1000) !== 0;
  if (worldWritable && !sticky) return "is world-writable without the sticky bit";

  // `currentUid` is undefined on Windows, where ownership works differently and
  // this rule does not apply.
  if (currentUid !== undefined && facts.uid !== currentUid && facts.uid !== 0) {
    return "is owned by another user";
  }
  return undefined;
}

export async function assertSafeSocketParent(path: string): Promise<void> {
  const parent = dirname(path);
  const reason = assessSocketParent(await describe(parent), process.getuid?.());
  if (reason !== undefined) throw new ConnectorSocketError(`parent directory ${parent} ${reason}`);
}

/**
 * Removes a leftover socket, and nothing else.
 *
 * Returns true when something was removed. A missing path is not an error: it
 * is the normal case on a first start.
 */
export async function removeStaleSocket(path: string): Promise<boolean> {
  const stats = await describe(path);
  if (stats === undefined) return false;

  if (stats.isSymbolicLink()) {
    // Following it would delete the target. Refusing is the whole point.
    throw new ConnectorSocketError(`${path} is a symbolic link`);
  }
  if (stats.isDirectory()) throw new ConnectorSocketError(`${path} is a directory`);
  if (!stats.isSocket()) {
    throw new ConnectorSocketError(`${path} exists and is not a socket`);
  }

  // There is an unavoidable gap between the check and the unlink. It is narrowed
  // rather than closed: the parent-directory check above is what makes swapping
  // the entry in that gap require privileges the attacker is assumed not to
  // have. A truly atomic answer needs an unlink-if-socket syscall, which the
  // platform does not offer.
  await unlink(path);
  return true;
}

/**
 * Prepares a path for binding: safe parent, no stale non-socket, no leftover socket.
 *
 * Called before `listen`, because binding over a leftover socket fails with
 * EADDRINUSE even when nothing is listening.
 */
export async function prepareSocketPath(path: string): Promise<void> {
  await assertSafeSocketParent(path);
  await removeStaleSocket(path);
}

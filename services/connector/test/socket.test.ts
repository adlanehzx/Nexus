import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConnectorSocketError,
  assessSocketParent,
  assertSafeSocketParent,
  prepareSocketPath,
  removeStaleSocket,
} from "../src/socket.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

/**
 * Creates a genuinely orphaned socket: a process binds it and is then killed.
 *
 * A killed process does not get to clean up, which is precisely how stale
 * sockets happen in the real world. Faking one by other means would test the
 * fake rather than the condition.
 */
async function createStaleSocket(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ["-e", "require('node:net').createServer().listen(process.argv[1])", path],
    { stdio: "ignore" },
  );
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const exists = await stat(path).then(
        (stats) => stats.isSocket(),
        () => false,
      );
      if (exists) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the helper never created a socket");
  } finally {
    child.kill("SIGKILL");
  }
}

posixOnly("stale socket removal", () => {
  it("removes an actual orphaned socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    const path = join(dir, "connector.sock");
    await createStaleSocket(path);

    await expect(removeStaleSocket(path)).resolves.toBe(true);
    await expect(stat(path)).rejects.toThrow();
  });

  it("does nothing when the path is free", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));

    // A first start is the normal case, not an error.
    await expect(removeStaleSocket(join(dir, "connector.sock"))).resolves.toBe(false);
  });

  it("never deletes a regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    const path = join(dir, "connector.sock");
    await writeFile(path, "something that matters", "utf8");

    await expect(removeStaleSocket(path)).rejects.toThrow(ConnectorSocketError);
    // The file, and its contents, are untouched.
    await expect(readFile(path, "utf8")).resolves.toBe("something that matters");
  });

  it("never follows a symbolic link to delete its target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    const target = join(dir, "precious.txt");
    const path = join(dir, "connector.sock");
    await writeFile(target, "do not delete me", "utf8");
    await symlink(target, path);

    await expect(removeStaleSocket(path)).rejects.toThrow(ConnectorSocketError);
    // Both the link and what it points at survive.
    await expect(readFile(target, "utf8")).resolves.toBe("do not delete me");
    await expect(stat(path)).resolves.toBeDefined();
  });

  it("never follows a symbolic link that points at a real socket either", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    const real = join(dir, "real.sock");
    const path = join(dir, "connector.sock");
    await createStaleSocket(real);
    await symlink(real, path);

    // The target being a socket does not make the link safe: the link is what
    // an attacker controls, and it can be repointed between check and unlink.
    await expect(removeStaleSocket(path)).rejects.toThrow(ConnectorSocketError);
    await expect(stat(real)).resolves.toBeDefined();
  });

  it("never deletes a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    const path = join(dir, "connector.sock");
    await mkdir(path);

    // Asserting on the wording, not only the type: a directory is also "not a
    // socket", so without this the dedicated check would be an unobservable
    // line and a reader would get the vaguer message.
    await expect(removeStaleSocket(path)).rejects.toThrow(/is a directory/);
    await expect(stat(path)).resolves.toBeDefined();
  });

  it("names the path so the refusal is actionable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    const path = join(dir, "connector.sock");
    await writeFile(path, "x", "utf8");

    await expect(removeStaleSocket(path)).rejects.toThrow(/is not a socket/);
  });
});

posixOnly("socket parent directory", () => {
  it("accepts a private directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));

    await expect(assertSafeSocketParent(join(dir, "connector.sock"))).resolves.toBeUndefined();
  });

  it("accepts a world-writable directory that has the sticky bit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    await chmod(dir, 0o1777);

    // This is what /tmp is, and the sticky bit is the mitigation: a non-owner
    // cannot remove our entry.
    await expect(assertSafeSocketParent(join(dir, "connector.sock"))).resolves.toBeUndefined();
  });

  it("refuses a world-writable directory without the sticky bit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    await chmod(dir, 0o777);

    // Any local user could replace our socket with theirs, and every client
    // would then authenticate to them.
    await expect(assertSafeSocketParent(join(dir, "connector.sock"))).rejects.toThrow(
      /world-writable/,
    );
  });

  it("refuses a parent that does not exist", async () => {
    await expect(
      assertSafeSocketParent(join(tmpdir(), `nexus-missing-${randomUUID()}`, "connector.sock")),
    ).rejects.toThrow(/does not exist/);
  });

  it("refuses a parent that is a symbolic link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    const real = join(dir, "real");
    const link = join(dir, "link");
    await mkdir(real);
    await symlink(real, link);

    await expect(assertSafeSocketParent(join(link, "connector.sock"))).rejects.toThrow(
      /symbolic link/,
    );
  });

  it("refuses a parent that is a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    const file = join(dir, "notadir");
    await writeFile(file, "x", "utf8");

    await expect(assertSafeSocketParent(join(file, "connector.sock"))).rejects.toThrow(
      /not a directory/,
    );
  });
});

posixOnly("preparing a socket path", () => {
  it("checks the parent before touching the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-socket-"));
    await chmod(dir, 0o777);
    const path = join(dir, "connector.sock");
    await createStaleSocket(path);

    await expect(prepareSocketPath(path)).rejects.toThrow(/world-writable/);
    // The socket survives: an unsafe parent stops us before any removal, so a
    // misconfiguration cannot be turned into a deletion.
    await expect(stat(path)).resolves.toBeDefined();
  });
});

describe("parent directory rules", () => {
  /** A private directory owned by the current user. */
  function directory(
    overrides: Partial<{ mode: number; uid: number; link: boolean; dir: boolean }> = {},
  ) {
    return {
      isSymbolicLink: () => overrides.link ?? false,
      isDirectory: () => overrides.dir ?? true,
      mode: overrides.mode ?? 0o700,
      uid: overrides.uid ?? 1000,
    };
  }

  it("accepts a private directory owned by us", () => {
    expect(assessSocketParent(directory(), 1000)).toBeUndefined();
  });

  it("accepts a directory owned by root", () => {
    // /tmp and /run are root-owned, and a service running as a user must still
    // be able to put a socket there.
    expect(assessSocketParent(directory({ uid: 0, mode: 0o1777 }), 1000)).toBeUndefined();
  });

  it("refuses a directory owned by another unprivileged user", () => {
    // Such a directory can be replaced wholesale, which defeats every other
    // check. Untestable against a real filesystem without a second account,
    // which is exactly why the rule is a pure function.
    expect(assessSocketParent(directory({ uid: 1001 }), 1000)).toBe("is owned by another user");
  });

  it("ignores ownership where the platform has no uid", () => {
    expect(assessSocketParent(directory({ uid: 1001 }), undefined)).toBeUndefined();
  });

  it("reports a missing directory", () => {
    expect(assessSocketParent(undefined, 1000)).toBe("does not exist");
  });

  it.each([
    [0o777, "is world-writable without the sticky bit"],
    [0o1777, undefined],
    [0o755, undefined],
    [0o700, undefined],
  ])("judges mode %s", (mode, expected) => {
    expect(assessSocketParent(directory({ mode, uid: 1000 }), 1000)).toBe(expected);
  });

  it("checks for a link before anything else", () => {
    // A link to a perfectly good directory is still a link.
    expect(assessSocketParent(directory({ link: true }), 1000)).toBe("is a symbolic link");
  });
});

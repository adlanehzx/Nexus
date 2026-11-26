import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileWorkspaces } from "../src/services/file-workspaces.js";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";
import { makeApi, createAccount } from "./harness.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nexus-file-scope-"));
  directories.push(directory);
  const root = join(directory, "allowed");
  const outside = join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { directory, root, outside };
}

describe("file workspace authorization", () => {
  it("persists grants and rejects crossed accounts, relative paths and symlink escapes", async () => {
    const { directory, root, outside } = await fixture();
    const store = new RuntimeConfigurationStore(join(directory, "config"));
    const access = new FileWorkspaces(store);
    const userId = randomUUID();
    const id = randomUUID();
    await access.save({ id, userId, root, label: "Work" });
    const restarted = new FileWorkspaces(store);
    expect(await restarted.authorize(userId, join(root, "new", "result"))).toBe(
      join(root, "new", "result"),
    );
    await expect(restarted.authorize(randomUUID(), root)).rejects.toThrow();
    await expect(restarted.authorize(userId, ".")).rejects.toThrow();
    await expect(restarted.authorize(userId, outside)).rejects.toThrow();
    await symlink(outside, join(root, "escape"));
    await expect(restarted.authorize(userId, join(root, "escape", "new"))).rejects.toThrow();
    await restarted.remove(id);
    await expect(access.authorize(userId, root)).rejects.toThrow();
  });

  it("runs registered document tools only inside the caller's granted folder", async () => {
    const { root } = await fixture();
    const filePath = join(root, "source.md");
    await writeFile(filePath, "# Evidence\n\nA concrete source document for the integration test.");
    const harness = await makeApi();
    try {
      const owner = await createAccount(harness, "document-owner@example.test");
      const other = await createAccount(harness, "document-other@example.test");
      await harness.services.fileWorkspaces.save({
        id: randomUUID(),
        userId: owner.userId,
        root,
        label: "Documents",
      });
      const context = (userId: string) => ({
        userId,
        runId: "document-integration",
        conversationId: "conversation",
        correlationId: "correlation",
        signal: new AbortController().signal,
        idempotencyKey: "document-integration",
        attempt: 1,
        onProgress: () => undefined,
      });
      const parse = harness.services.toolRegistry.require<
        { filePath: string },
        { fullText: string }
      >("document.parse");
      expect((await parse.execute({ filePath }, context(owner.userId))).fullText).toContain(
        "concrete source document",
      );
      await expect(parse.execute({ filePath }, context(other.userId))).rejects.toThrow();
      const ingest = harness.services.toolRegistry.require<
        { filePath: string },
        { chunksIngested: number; citationUris: string[] }
      >("document.ingest_to_memory");
      const result = await ingest.execute({ filePath }, context(owner.userId));
      expect(result.chunksIngested).toBeGreaterThan(0);
      expect(result.citationUris.length).toBeGreaterThan(0);
      await expect(ingest.execute({ filePath }, context(other.userId))).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });

  it("requires an admin grant and isolates checkpoints even with the same thread name", async () => {
    const { root, outside } = await fixture();
    const harness = await makeApi();
    try {
      const owner = await createAccount(harness, "owner-scope@example.test");
      const member = await createAccount(harness, "member-scope@example.test");
      const request = (headers: Record<string, string>, cwd: string) =>
        harness.app.inject({
          method: "POST",
          url: "/api/v1/checkpoints",
          headers,
          payload: { cwd, threadId: "same-thread", turnNumber: 1 },
        });
      expect((await request(owner.authorization, root)).statusCode).toBe(403);
      const grant = await harness.app.inject({
        method: "POST",
        url: "/api/v1/file-workspaces",
        headers: owner.authorization,
        payload: { root, label: "Work" },
      });
      expect(grant.statusCode).toBe(201);
      expect(
        (
          await harness.app.inject({
            method: "POST",
            url: "/api/v1/file-workspaces",
            headers: member.authorization,
            payload: { root: outside, label: "Unapproved" },
          })
        ).statusCode,
      ).toBe(403);
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      expect((await request(owner.authorization, root)).statusCode).toBe(201);
      expect((await request(member.authorization, root)).statusCode).toBe(403);
      const list = await harness.app.inject({
        method: "GET",
        url: "/api/v1/checkpoints/same-thread",
        headers: member.authorization,
      });
      expect(list.json().checkpoints).toEqual([]);
      const ownerList = () =>
        harness.app.inject({
          method: "GET",
          url: "/api/v1/checkpoints/same-thread",
          headers: owner.authorization,
        });
      expect((await ownerList()).json().checkpoints).toHaveLength(1);
      await harness.app.inject({
        method: "DELETE",
        url: `/api/v1/file-workspaces/${grant.json().id}`,
        headers: owner.authorization,
      });
      expect((await ownerList()).json().checkpoints).toEqual([]);

      for (const url of [
        "/api/v1/worktrees",
        "/api/v1/checkpoints/same-thread/diff?fromTurn=0&toTurn=1&cwd=" + encodeURIComponent(root),
      ]) {
        expect(
          (await harness.app.inject({ method: "GET", url, headers: member.authorization }))
            .statusCode,
        ).toBe(403);
      }
    } finally {
      await harness.close();
    }
  });
});

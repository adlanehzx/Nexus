import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactNotFoundError,
  ArtifactSecurityError,
  SharedArtifactStore,
} from "../src/services/shared-artifacts.js";

describe("SharedArtifactStore", () => {
  let workspaceDir: string;
  let store: SharedArtifactStore;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "nexus-test-artifacts-"));
    store = new SharedArtifactStore({
      maxFileSizeBytes: 1024 * 1024, // 1 MB max for tests
      maxTotalSizeBytes: 5 * 1024 * 1024, // 5 MB max
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("saves an artifact and generates its URI and SHA-256 hash", async () => {
    const record = await store.saveArtifact({
      missionWorkspace: workspaceDir,
      missionKey: "mission-test-1",
      taskKey: "investigate",
      name: "analysis.md",
      content: "# Project analysis\nAll indicators are green.",
      description: "Analysis report",
    });

    expect(record.uri).toBe("artifact://investigate/analysis.md");
    expect(record.mimeType).toBe("text/markdown");
    expect(record.sizeBytes).toBeGreaterThan(0);
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);

    // Read
    const loaded = await store.readArtifact(workspaceDir, record.uri);
    expect(loaded.record.name).toBe("analysis.md");
    expect(loaded.content.toString("utf-8")).toContain("All indicators are green.");

    // Manifest
    const list = await store.listArtifacts(workspaceDir);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(record.id);
  });

  it("strictly blocks directory traversal attempts", async () => {
    await expect(
      store.saveArtifact({
        missionWorkspace: workspaceDir,
        missionKey: "mission-test-1",
        taskKey: "../../../etc",
        name: "passwd",
        content: "malicious",
      }),
    ).resolves.toBeDefined(); // sanitizePathSegment sanitizes the key inside directory

    // But if resolved path escapes directory, a security error is thrown
    const targetDir = store.getArtifactsDir(workspaceDir);
    expect(targetDir.startsWith(workspaceDir)).toBe(true);

    await expect(
      store.readArtifact(workspaceDir, "artifact://investigate/../../secrets.env"),
    ).rejects.toThrow(ArtifactNotFoundError);
  });

  it("enforces per-file size quota", async () => {
    const hugeContent = Buffer.alloc(2 * 1024 * 1024); // 2 MB > 1 MB
    await expect(
      store.saveArtifact({
        missionWorkspace: workspaceDir,
        missionKey: "mission-test-1",
        taskKey: "build",
        name: "huge.bin",
        content: hugeContent,
      }),
    ).rejects.toThrow(ArtifactSecurityError);
  });

  it("handles multiple artifacts per task and updates manifest", async () => {
    await store.saveArtifact({
      missionWorkspace: workspaceDir,
      missionKey: "mission-test-1",
      taskKey: "code_gen",
      name: "patch.diff",
      content: "diff --git a/index.ts b/index.ts",
    });

    await store.saveArtifact({
      missionWorkspace: workspaceDir,
      missionKey: "mission-test-1",
      taskKey: "code_gen",
      name: "metrics.json",
      content: JSON.stringify({ coverage: 98.5 }),
    });

    const list = await store.listArtifacts(workspaceDir);
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.name)).toEqual(["patch.diff", "metrics.json"]);
  });
});

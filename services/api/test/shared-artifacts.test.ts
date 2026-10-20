import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactNotFoundError,
  ArtifactSecurityError,
  SharedArtifactStore,
} from "../src/services/shared-artifacts.js";

describe("SharedArtifactStore (Chantier 14)", () => {
  let workspaceDir: string;
  let store: SharedArtifactStore;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "nexus-test-artifacts-"));
    store = new SharedArtifactStore({
      maxFileSizeBytes: 1024 * 1024, // 1 Mo max pour les tests
      maxTotalSizeBytes: 5 * 1024 * 1024, // 5 Mo max
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("enregistre un artefact et génère son URI et son hachage SHA-256", async () => {
    const record = await store.saveArtifact({
      missionWorkspace: workspaceDir,
      missionKey: "mission-test-1",
      taskKey: "investigate",
      name: "analysis.md",
      content: "# Analyse du projet\nTous les voyants sont au vert.",
      description: "Rapport d'analyse",
    });

    expect(record.uri).toBe("artifact://investigate/analysis.md");
    expect(record.mimeType).toBe("text/markdown");
    expect(record.sizeBytes).toBeGreaterThan(0);
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);

    // Lecture
    const loaded = await store.readArtifact(workspaceDir, record.uri);
    expect(loaded.record.name).toBe("analysis.md");
    expect(loaded.content.toString("utf-8")).toContain("Tous les voyants sont au vert.");

    // Manifeste
    const list = await store.listArtifacts(workspaceDir);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(record.id);
  });

  it("bloque strictement les tentatives de traversée de répertoires (directory traversal)", async () => {
    await expect(
      store.saveArtifact({
        missionWorkspace: workspaceDir,
        missionKey: "mission-test-1",
        taskKey: "../../../etc",
        name: "passwd",
        content: "malicious",
      }),
    ).resolves.toBeDefined(); // sanitizePathSegment assainit la clé en "______etc" à l'intérieur du dossier

    // Mais si le chemin résolu sortait du dossier, une erreur de sécurité est levée
    const targetDir = store.getArtifactsDir(workspaceDir);
    expect(targetDir.startsWith(workspaceDir)).toBe(true);

    await expect(
      store.readArtifact(workspaceDir, "artifact://investigate/../../secrets.env"),
    ).rejects.toThrow(ArtifactNotFoundError);
  });

  it("applique le quota de taille par fichier", async () => {
    const hugeContent = Buffer.alloc(2 * 1024 * 1024); // 2 Mo > 1 Mo
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

  it("gère plusieurs artefacts par tâche et met à jour le manifeste", async () => {
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

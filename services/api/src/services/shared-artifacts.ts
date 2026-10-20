import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";

export const sharedArtifactRecordSchema = z.object({
  id: z.string().uuid(),
  missionKey: z.string().min(1).max(128),
  taskKey: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  relativePath: z.string().min(1).max(1024),
  uri: z.string().regex(/^artifact:\/\/[a-z0-9_-]+\/.+$/i),
  mimeType: z.string().min(1).max(128),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  description: z.string().max(2000),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});

export type SharedArtifactRecord = z.infer<typeof sharedArtifactRecordSchema>;

const artifactManifestSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime(),
  artifacts: z.array(sharedArtifactRecordSchema),
});

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

export interface SaveArtifactInput {
  missionWorkspace: string;
  missionKey: string;
  taskKey: string;
  name: string;
  content: Buffer | string;
  description?: string | undefined;
  mimeType?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export class ArtifactSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactSecurityError";
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}

/**
 * Gestionnaire d'artefacts partagés entre agents dans le workspace d'une mission.
 *
 * Tous les fichiers sont cantonnés dans un sous-dossier `artifacts/` sécurisé.
 * Les traversées de répertoires (`..`, liens symboliques hors workspace) sont
 * strictement rejetées.
 */
export class SharedArtifactStore {
  readonly #maxFileSizeBytes: number;
  readonly #maxTotalSizeBytes: number;

  constructor(options?: { maxFileSizeBytes?: number; maxTotalSizeBytes?: number }) {
    this.#maxFileSizeBytes = options?.maxFileSizeBytes ?? 25 * 1024 * 1024; // 25 Mo max par fichier
    this.#maxTotalSizeBytes = options?.maxTotalSizeBytes ?? 100 * 1024 * 1024; // 100 Mo max par mission
  }

  /**
   * Retourne le chemin canonique du dossier d'artefacts d'une mission.
   */
  getArtifactsDir(missionWorkspace: string): string {
    return resolve(missionWorkspace, "artifacts");
  }

  /**
   * Enregistre un artefact dans l'espace partagé de la mission et met à jour le manifeste.
   */
  async saveArtifact(input: SaveArtifactInput): Promise<SharedArtifactRecord> {
    const artifactsDir = this.getArtifactsDir(input.missionWorkspace);
    await mkdir(artifactsDir, { recursive: true, mode: 0o700 });

    const safeTaskKey = sanitizePathSegment(input.taskKey);
    const safeName = sanitizeFilename(input.name);
    const taskDir = resolve(artifactsDir, safeTaskKey);
    this.#assertInsideDir(artifactsDir, taskDir);
    await mkdir(taskDir, { recursive: true, mode: 0o700 });

    const targetPath = resolve(taskDir, safeName);
    this.#assertInsideDir(artifactsDir, targetPath);

    const buffer = typeof input.content === "string" ? Buffer.from(input.content, "utf-8") : input.content;

    if (buffer.length > this.#maxFileSizeBytes) {
      throw new ArtifactSecurityError(
        `L'artefact dépasse la taille maximale autorisée (${buffer.length} > ${this.#maxFileSizeBytes} octets).`,
      );
    }

    const currentManifest = await this.loadManifest(input.missionWorkspace);
    const currentTotalSize = currentManifest.artifacts.reduce((acc, a) => acc + a.sizeBytes, 0);
    if (currentTotalSize + buffer.length > this.#maxTotalSizeBytes) {
      throw new ArtifactSecurityError(
        `Le quota total d'artefacts pour cette mission est dépassé (${currentTotalSize + buffer.length} > ${this.#maxTotalSizeBytes} octets).`,
      );
    }

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const mimeType = input.mimeType ?? guessMimeType(safeName);
    const relativePath = relative(artifactsDir, targetPath).replace(/\\/g, "/");
    const uri = `artifact://${safeTaskKey}/${safeName}`;
    const now = new Date().toISOString();

    await writeFile(targetPath, buffer, { mode: 0o600 });

    const record: SharedArtifactRecord = {
      id: randomUUID(),
      missionKey: input.missionKey,
      taskKey: safeTaskKey,
      name: safeName,
      relativePath,
      uri,
      mimeType,
      sizeBytes: buffer.length,
      sha256,
      description: input.description ?? `Artefact généré par ${safeTaskKey}`,
      metadata: input.metadata ?? {},
      createdAt: now,
    };

    // Mettre à jour le manifeste atomiquement
    const filtered = currentManifest.artifacts.filter((a) => a.uri !== uri);
    const updatedManifest: ArtifactManifest = {
      version: 1,
      updatedAt: now,
      artifacts: [...filtered, record],
    };
    await this.#saveManifest(input.missionWorkspace, updatedManifest);

    return record;
  }

  /**
   * Lit un artefact par son URI ou son chemin relatif.
   */
  async readArtifact(
    missionWorkspace: string,
    uriOrRelativePath: string,
  ): Promise<{ record: SharedArtifactRecord; content: Buffer }> {
    const manifest = await this.loadManifest(missionWorkspace);
    const record = manifest.artifacts.find(
      (a) => a.uri === uriOrRelativePath || a.relativePath === uriOrRelativePath || a.name === uriOrRelativePath,
    );

    if (!record) {
      throw new ArtifactNotFoundError(`Artefact introuvable : ${uriOrRelativePath}`);
    }

    const artifactsDir = this.getArtifactsDir(missionWorkspace);
    const filePath = resolve(artifactsDir, record.relativePath);
    this.#assertInsideDir(artifactsDir, filePath);

    try {
      const content = await readFile(filePath);
      return { record, content };
    } catch (err) {
      throw new ArtifactNotFoundError(
        `Fichier artefact inaccessible : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Liste l'ensemble des artefacts d'une mission.
   */
  async listArtifacts(missionWorkspace: string): Promise<SharedArtifactRecord[]> {
    const manifest = await this.loadManifest(missionWorkspace);
    return manifest.artifacts;
  }

  /**
   * Charge le manifeste des artefacts pour un workspace.
   */
  async loadManifest(missionWorkspace: string): Promise<ArtifactManifest> {
    const artifactsDir = this.getArtifactsDir(missionWorkspace);
    const manifestPath = join(artifactsDir, "manifest.json");
    try {
      const content = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      return artifactManifestSchema.parse(parsed);
    } catch {
      return {
        version: 1,
        updatedAt: new Date().toISOString(),
        artifacts: [],
      };
    }
  }

  async #saveManifest(missionWorkspace: string, manifest: ArtifactManifest): Promise<void> {
    const artifactsDir = this.getArtifactsDir(missionWorkspace);
    await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
    const manifestPath = join(artifactsDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  }

  #assertInsideDir(parentDir: string, targetPath: string): void {
    const normalizedParent = resolve(normalize(parentDir));
    const normalizedTarget = resolve(normalize(targetPath));
    if (!normalizedTarget.startsWith(normalizedParent + "/") && normalizedTarget !== normalizedParent) {
      throw new ArtifactSecurityError(`Tentative de traversée de répertoire détectée : ${targetPath}`);
    }
  }
}

function sanitizePathSegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "task";
}

function sanitizeFilename(filename: string): string {
  const base = basename(filename);
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return "artifact.bin";
  }
  return cleaned;
}

export function guessMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".diff") || lower.endsWith(".patch")) return "text/x-diff";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".ts")) return "text/typescript";
  if (lower.endsWith(".js")) return "text/javascript";
  if (lower.endsWith(".py")) return "text/x-python";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

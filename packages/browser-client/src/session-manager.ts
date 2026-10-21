import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { uuidv7 } from "@nexus/shared";
import type { BrowserHarnessDriver, PageInfo } from "./harness-driver.js";
import { BrowserSecurityPolicy, type BrowserSecurityOptions } from "./security-policy.js";

export interface NativeBrowserSession {
  sessionId: string;
  targetId: string;
  actionCount: number;
  maxActions: number;
  createdAt: number;
  lastActiveAt: number;
  maxDurationMs: number;
  currentUrl?: string;
  title?: string;
  waitingForHuman?: {
    reason: string;
    pageUrl: string;
    suspendedAt: number;
  };
}

export interface BrowserArtifact {
  id: string;
  sessionId: string;
  type: "screenshot" | "dom_snapshot";
  filePath: string;
  fileName: string;
  createdAt: string;
  url: string;
  title: string;
}

export interface SessionManagerOptions {
  driver: BrowserHarnessDriver;
  securityPolicy?: BrowserSecurityPolicy;
  artifactsDirectory?: string;
  defaultMaxActions?: number;
  defaultMaxDurationMs?: number;
  securityOptions?: BrowserSecurityOptions;
}

export class QuotaExceededError extends Error {
  readonly code = "BROWSER_QUOTA_EXCEEDED";
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/**
 * Manages per-mission browser session isolation and artifacts.
 */
export class BrowserSessionManager {
  readonly #driver: BrowserHarnessDriver;
  readonly #policy: BrowserSecurityPolicy;
  readonly #artifactsDirectory: string;
  readonly #defaultMaxActions: number;
  readonly #defaultMaxDurationMs: number;
  readonly #sessions = new Map<string, NativeBrowserSession>();
  readonly #artifacts = new Map<string, BrowserArtifact>();

  constructor(options: SessionManagerOptions) {
    this.#driver = options.driver;
    this.#policy = options.securityPolicy ?? new BrowserSecurityPolicy(options.securityOptions);
    this.#artifactsDirectory =
      options.artifactsDirectory ?? resolve(process.cwd(), "var/artifacts/browser");
    this.#defaultMaxActions = options.defaultMaxActions ?? 50;
    this.#defaultMaxDurationMs = options.defaultMaxDurationMs ?? 300_000; // 5 min
  }

  get driver(): BrowserHarnessDriver {
    return this.#driver;
  }

  get policy(): BrowserSecurityPolicy {
    return this.#policy;
  }

  get artifactsDirectory(): string {
    return this.#artifactsDirectory;
  }

  /**
   * Retrieves or allocates a dedicated Chromium tab for a given session.
   */
  async getOrCreateSession(sessionId: string): Promise<NativeBrowserSession> {
    const existing = this.#sessions.get(sessionId);
    if (existing) {
      const now = Date.now();
      if (now - existing.createdAt > existing.maxDurationMs) {
        throw new QuotaExceededError(
          `Maximum browser session duration exceeded (${Math.round(existing.maxDurationMs / 1000)}s).`,
        );
      }
      try {
        await this.#driver.switchTab(existing.targetId);
        existing.lastActiveAt = now;
        return existing;
      } catch {
        this.#sessions.delete(sessionId);
      }
    }

    const targetId = await this.#driver.createTab();
    const session: NativeBrowserSession = {
      sessionId,
      targetId,
      actionCount: 0,
      maxActions: this.#defaultMaxActions,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      maxDurationMs: this.#defaultMaxDurationMs,
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  /**
   * Records an action on the session and checks quotas.
   */
  recordAction(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;

    session.actionCount += 1;
    session.lastActiveAt = Date.now();

    if (session.actionCount > session.maxActions) {
      throw new QuotaExceededError(
        `Maximum browser action quota exceeded for this session (${session.maxActions} actions max). ` +
          "Session interrupted to prevent infinite loops.",
      );
    }

    if (session.lastActiveAt - session.createdAt > session.maxDurationMs) {
      throw new QuotaExceededError(
        `Maximum browser session duration exceeded for this session (${Math.round(session.maxDurationMs / 1000)}s max).`,
      );
    }
  }

  /**
   * Suspends session pending human intervention.
   */
  suspendForHumanIntervention(sessionId: string, reason: string, pageUrl: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.waitingForHuman = {
      reason,
      pageUrl,
      suspendedAt: Date.now(),
    };
  }

  /**
   * Resumes session following human intervention.
   */
  resumeAfterHumanIntervention(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    delete session.waitingForHuman;
    session.lastActiveAt = Date.now();
  }

  /**
   * Persists a screenshot as a mission artifact.
   */
  async saveScreenshotArtifact(
    sessionId: string,
    sourcePath: string,
    info: PageInfo,
  ): Promise<BrowserArtifact> {
    const artifactId = uuidv7();
    const fileName = `${Date.now()}-${artifactId.slice(0, 8)}.png`;
    const destinationDir = join(this.#artifactsDirectory, sessionId);
    const destinationPath = join(destinationDir, fileName);

    await mkdir(destinationDir, { recursive: true });
    await copyFile(sourcePath, destinationPath);

    const artifact: BrowserArtifact = {
      id: artifactId,
      sessionId,
      type: "screenshot",
      filePath: destinationPath,
      fileName,
      createdAt: new Date().toISOString(),
      url: info.url,
      title: info.title,
    };

    this.#artifacts.set(artifactId, artifact);
    return artifact;
  }

  /**
   * Closes session tab and releases resources.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;

    try {
      await this.#driver.closeTab(session.targetId);
    } catch {
      // Ignored if already closed
    } finally {
      this.#sessions.delete(sessionId);
    }
  }

  /**
   * Closes all active sessions.
   */
  async closeAllSessions(): Promise<void> {
    const sessionIds = Array.from(this.#sessions.keys());
    for (const sid of sessionIds) {
      await this.closeSession(sid);
    }
  }

  getSession(sessionId: string): NativeBrowserSession | undefined {
    return this.#sessions.get(sessionId);
  }

  listActiveSessions(): NativeBrowserSession[] {
    return Array.from(this.#sessions.values());
  }

  getArtifact(artifactId: string): BrowserArtifact | undefined {
    return this.#artifacts.get(artifactId);
  }

  listSessionArtifacts(sessionId: string): BrowserArtifact[] {
    return Array.from(this.#artifacts.values()).filter((a) => a.sessionId === sessionId);
  }
}

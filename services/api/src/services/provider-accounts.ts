import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeConfigurationStore } from "./runtime-configuration.js";

export const authStatusSchema = z.enum(["authenticated", "unauthenticated", "expired", "unknown"]);
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const providerAccountQuotasSchema = z.object({
  remaining5hPercent: z.number().int().min(0).max(100).nullable().default(null),
  remainingWeekPercent: z.number().int().min(0).max(100).nullable().default(null),
  resets5hAt: z.string().nullable().default(null),
  resetsWeekAt: z.string().nullable().default(null),
  exhausted: z.boolean().default(false),
});
export type ProviderAccountQuotas = z.infer<typeof providerAccountQuotasSchema>;

export const providerAccountCooldownSchema = z.object({
  active: z.boolean().default(false),
  until: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
});
export type ProviderAccountCooldown = z.infer<typeof providerAccountCooldownSchema>;

export const providerAccountReliabilitySchema = z.object({
  score: z.number().min(0).max(1).default(1.0),
  totalRuns: z.number().int().nonnegative().default(0),
  successCount: z.number().int().nonnegative().default(0),
  failureCount: z.number().int().nonnegative().default(0),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  lastErrorCategory: z.string().nullable().default(null),
  lastErrorAt: z.string().nullable().default(null),
});
export type ProviderAccountReliability = z.infer<typeof providerAccountReliabilitySchema>;

export const providerAccountSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  provider: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  profileKey: z.string().min(1).max(64),
  sessionDir: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  authStatus: authStatusSchema.default("unknown"),
  lastCheckedAt: z.string().nullable().default(null),
  quotas: providerAccountQuotasSchema.default({
    remaining5hPercent: null,
    remainingWeekPercent: null,
    resets5hAt: null,
    resetsWeekAt: null,
    exhausted: false,
  }),
  cooldown: providerAccountCooldownSchema.default({
    active: false,
    until: null,
    reason: null,
  }),
  priority: z.number().int().min(1).max(100).default(1),
  reliability: providerAccountReliabilitySchema.default({
    score: 1.0,
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    lastErrorCategory: null,
    lastErrorAt: null,
  }),
  metadata: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProviderAccount = z.infer<typeof providerAccountSchema>;

export const createProviderAccountSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  provider: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  profileKey: z.string().min(1).max(64),
  sessionDir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  priority: z.number().int().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateProviderAccountInput = z.infer<typeof createProviderAccountSchema>;

export const updateProviderAccountSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  profileKey: z.string().min(1).max(64).optional(),
  priority: z.number().int().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateProviderAccountInput = z.infer<typeof updateProviderAccountSchema>;

export interface ProviderAccountServiceOptions {
  runtimeConfiguration: RuntimeConfigurationStore;
  now?: () => Date;
}

export class ProviderAccountService {
  readonly #config: RuntimeConfigurationStore;
  readonly #now: () => Date;

  constructor(options: ProviderAccountServiceOptions) {
    this.#config = options.runtimeConfiguration;
    this.#now = options.now ?? (() => new Date());
  }

  /** Initialize with default accounts if the file does not exist yet. */
  defaultAccounts(): ProviderAccount[] {
    const timestamp = this.#now().toISOString();
    const baseDir = join(homedir(), ".nexus", "agents", "sessions");
    return [
      {
        id: "antigravity-personnel",
        provider: "antigravity",
        name: "Antigravity Personnel",
        profileKey: "antigravity",
        sessionDir: join(baseDir, "antigravity-personnel"),
        env: {},
        authStatus: "unknown",
        lastCheckedAt: null,
        quotas: {
          remaining5hPercent: null,
          remainingWeekPercent: null,
          resets5hAt: null,
          resetsWeekAt: null,
          exhausted: false,
        },
        cooldown: { active: false, until: null, reason: null },
        priority: 1,
        reliability: {
          score: 1.0,
          totalRuns: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          lastErrorCategory: null,
          lastErrorAt: null,
        },
        metadata: { tier: "pro" },
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "claude-principal",
        provider: "claude",
        name: "Claude Pro Principal",
        profileKey: "claude",
        sessionDir: join(baseDir, "claude-principal"),
        env: {},
        authStatus: "unknown",
        lastCheckedAt: null,
        quotas: {
          remaining5hPercent: null,
          remainingWeekPercent: null,
          resets5hAt: null,
          resetsWeekAt: null,
          exhausted: false,
        },
        cooldown: { active: false, until: null, reason: null },
        priority: 1,
        reliability: {
          score: 1.0,
          totalRuns: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          lastErrorCategory: null,
          lastErrorAt: null,
        },
        metadata: { tier: "claude-pro" },
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "codex-principal",
        provider: "codex",
        name: "Codex Principal",
        profileKey: "codex",
        sessionDir: join(baseDir, "codex-principal"),
        env: {},
        authStatus: "unknown",
        lastCheckedAt: null,
        quotas: {
          remaining5hPercent: null,
          remainingWeekPercent: null,
          resets5hAt: null,
          resetsWeekAt: null,
          exhausted: false,
        },
        cooldown: { active: false, until: null, reason: null },
        priority: 1,
        reliability: {
          score: 1.0,
          totalRuns: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          lastErrorCategory: null,
          lastErrorAt: null,
        },
        metadata: { tier: "chatgpt-plus" },
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
  }

  async listAccounts(): Promise<ProviderAccount[]> {
    let accounts = await this.#config.loadProviderAccounts();
    if (accounts === null) {
      accounts = this.defaultAccounts();
      await this.#config.saveProviderAccounts(accounts);
    }

    const now = this.#now();
    let updated = false;

    // Automatically clean up expired cooldowns
    const refreshed = accounts.map((account) => {
      if (account.cooldown.active && account.cooldown.until !== null) {
        if (new Date(account.cooldown.until).getTime() <= now.getTime()) {
          updated = true;
          return {
            ...account,
            cooldown: { active: false, until: null, reason: null },
            updatedAt: now.toISOString(),
          };
        }
      }
      return account;
    });

    if (updated) {
      await this.#config.saveProviderAccounts(refreshed);
    }

    return refreshed;
  }

  async getAccount(id: string): Promise<ProviderAccount | undefined> {
    const accounts = await this.listAccounts();
    return accounts.find((acc) => acc.id === id);
  }

  async createAccount(input: CreateProviderAccountInput): Promise<ProviderAccount> {
    const validated = createProviderAccountSchema.parse(input);
    const accounts = await this.listAccounts();

    if (accounts.some((acc) => acc.id === validated.id)) {
      throw new Error(`Provider account "${validated.id}" already exists.`);
    }

    const nowIso = this.#now().toISOString();
    const sessionDir =
      validated.sessionDir ?? join(homedir(), ".nexus", "agents", "sessions", validated.id);

    const newAccount: ProviderAccount = {
      id: validated.id,
      provider: validated.provider,
      name: validated.name,
      profileKey: validated.profileKey,
      sessionDir,
      env: validated.env ?? {},
      authStatus: "unknown",
      lastCheckedAt: null,
      enabled: validated.enabled ?? true,
      quotas: {
        remaining5hPercent: null,
        remainingWeekPercent: null,
        resets5hAt: null,
        resetsWeekAt: null,
        exhausted: false,
      },
      cooldown: { active: false, until: null, reason: null },
      priority: validated.priority ?? 1,
      reliability: {
        score: 1.0,
        totalRuns: 0,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        lastErrorCategory: null,
        lastErrorAt: null,
      },
      metadata: validated.metadata ?? {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    accounts.push(newAccount);
    await this.#config.saveProviderAccounts(accounts);
    return newAccount;
  }

  async updateAccount(
    id: string,
    input: UpdateProviderAccountInput,
  ): Promise<ProviderAccount | undefined> {
    const accounts = await this.listAccounts();
    const index = accounts.findIndex((acc) => acc.id === id);
    if (index === -1) return undefined;

    const existing = accounts[index];
    if (existing === undefined) return undefined;

    const nowIso = this.#now().toISOString();
    const updated: ProviderAccount = {
      ...existing,
      name: input.name ?? existing.name,
      profileKey: input.profileKey ?? existing.profileKey,
      priority: input.priority ?? existing.priority,
      enabled: input.enabled ?? existing.enabled,
      env: input.env !== undefined ? { ...existing.env, ...input.env } : existing.env,
      metadata:
        input.metadata !== undefined
          ? { ...existing.metadata, ...input.metadata }
          : existing.metadata,
      updatedAt: nowIso,
    };

    accounts[index] = updated;
    await this.#config.saveProviderAccounts(accounts);
    return updated;
  }

  async setAccountEnabled(id: string, enabled: boolean): Promise<ProviderAccount | undefined> {
    return this.updateAccount(id, { enabled });
  }

  async deleteAccount(id: string): Promise<boolean> {
    const accounts = await this.listAccounts();
    const filtered = accounts.filter((acc) => acc.id !== id);
    if (filtered.length === accounts.length) return false;

    await this.#config.saveProviderAccounts(filtered);
    return true;
  }

  async setCooldown(
    id: string,
    durationSeconds: number,
    reason: string,
  ): Promise<ProviderAccount | undefined> {
    const accounts = await this.listAccounts();
    const index = accounts.findIndex((acc) => acc.id === id);
    if (index === -1) return undefined;

    const existing = accounts[index];
    if (existing === undefined) return undefined;

    const now = this.#now();
    const until = new Date(now.getTime() + durationSeconds * 1000).toISOString();

    const updated: ProviderAccount = {
      ...existing,
      cooldown: {
        active: true,
        until,
        reason,
      },
      updatedAt: now.toISOString(),
    };

    accounts[index] = updated;
    await this.#config.saveProviderAccounts(accounts);
    return updated;
  }

  async clearCooldown(id: string): Promise<ProviderAccount | undefined> {
    const accounts = await this.listAccounts();
    const index = accounts.findIndex((acc) => acc.id === id);
    if (index === -1) return undefined;

    const existing = accounts[index];
    if (existing === undefined) return undefined;

    const updated: ProviderAccount = {
      ...existing,
      cooldown: {
        active: false,
        until: null,
        reason: null,
      },
      updatedAt: this.#now().toISOString(),
    };

    accounts[index] = updated;
    await this.#config.saveProviderAccounts(accounts);
    return updated;
  }

  async recordOutcome(
    id: string,
    outcome: { success: boolean; errorCategory?: string | undefined },
  ): Promise<ProviderAccount | undefined> {
    const accounts = await this.listAccounts();
    const index = accounts.findIndex((acc) => acc.id === id);
    if (index === -1) return undefined;

    const existing = accounts[index];
    if (existing === undefined) return undefined;

    const now = this.#now();
    const totalRuns = existing.reliability.totalRuns + 1;
    const successCount = existing.reliability.successCount + (outcome.success ? 1 : 0);
    const failureCount = existing.reliability.failureCount + (outcome.success ? 0 : 1);
    const consecutiveFailures = outcome.success ? 0 : existing.reliability.consecutiveFailures + 1;
    const score = Number((successCount / totalRuns).toFixed(2));

    const reliability: ProviderAccountReliability = {
      score,
      totalRuns,
      successCount,
      failureCount,
      consecutiveFailures,
      lastErrorCategory: outcome.success
        ? existing.reliability.lastErrorCategory
        : (outcome.errorCategory ?? "unknown"),
      lastErrorAt: outcome.success ? existing.reliability.lastErrorAt : now.toISOString(),
    };

    let cooldown = existing.cooldown;
    let authStatus = existing.authStatus;
    let quotas = existing.quotas;

    // Automatically trigger cooldown according to error category
    if (!outcome.success) {
      if (outcome.errorCategory === "rate_limited") {
        cooldown = {
          active: true,
          until: new Date(now.getTime() + 60_000).toISOString(),
          reason: "Rate limit detected by CLI",
        };
      } else if (outcome.errorCategory === "quota_exhausted") {
        quotas = { ...quotas, exhausted: true };
        cooldown = {
          active: true,
          until: new Date(now.getTime() + 300_000).toISOString(),
          reason: "Quota exhausted on this identity",
        };
      } else if (outcome.errorCategory === "auth_required") {
        authStatus = "expired";
        cooldown = {
          active: true,
          until: new Date(now.getTime() + 600_000).toISOString(),
          reason: "Session or authentication token expired",
        };
      }
    } else {
      if (authStatus === "expired" || authStatus === "unknown") {
        authStatus = "authenticated";
      }
      if (quotas.exhausted) {
        quotas = { ...quotas, exhausted: false };
      }
    }

    const updated: ProviderAccount = {
      ...existing,
      authStatus,
      quotas,
      cooldown,
      reliability,
      updatedAt: now.toISOString(),
    };

    accounts[index] = updated;
    await this.#config.saveProviderAccounts(accounts);
    return updated;
  }

  async probeAuth(id: string): Promise<ProviderAccount | undefined> {
    const accounts = await this.listAccounts();
    const index = accounts.findIndex((acc) => acc.id === id);
    if (index === -1) return undefined;

    const existing = accounts[index];
    if (existing === undefined) return undefined;

    // probeAuth must never promote an authentication status without evidence.
    const nowIso = this.#now().toISOString();
    let authStatus: AuthStatus = existing.authStatus;

    if (existing.reliability.lastErrorCategory === "auth_required") {
      authStatus = "expired";
    } else if (
      existing.reliability.successCount > 0 &&
      existing.reliability.consecutiveFailures === 0
    ) {
      authStatus = "authenticated";
    } else if (existsSync(existing.sessionDir)) {
      authStatus = "authenticated";
    } else if (authStatus === "unknown") {
      authStatus = "unknown";
    }

    const updated: ProviderAccount = {
      ...existing,
      authStatus,
      lastCheckedAt: nowIso,
      updatedAt: nowIso,
    };

    accounts[index] = updated;
    await this.#config.saveProviderAccounts(accounts);
    return updated;
  }

  /**
   * Selects the best available identity for a given provider.
   * Filters out disabled identities, those in cooldown, quota exhausted, or auth expired,
   * then sorts by priority (1 before 2), reliability score, and consecutive failures.
   */
  async selectAccount(
    provider: string,
    options?: { preferredId?: string | undefined },
  ): Promise<ProviderAccount | undefined> {
    const accounts = await this.listAccounts();
    const matching = accounts.filter((acc) => acc.provider === provider);

    const candidates = matching.filter(
      (acc) =>
        acc.enabled !== false &&
        !acc.cooldown.active &&
        !acc.quotas.exhausted &&
        acc.authStatus !== "expired" &&
        acc.authStatus !== "unauthenticated",
    );

    if (candidates.length === 0) {
      // If all are in cooldown or exhausted, pick the first that is not expired
      return matching.find((acc) => acc.authStatus !== "expired");
    }

    if (options?.preferredId !== undefined) {
      const preferred = candidates.find((acc) => acc.id === options.preferredId);
      if (preferred !== undefined) return preferred;
    }

    // Sort: priority ascending (1 = high priority), reliability descending, consecutive errors ascending
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (b.reliability.score !== a.reliability.score) {
        return b.reliability.score - a.reliability.score;
      }
      return a.reliability.consecutiveFailures - b.reliability.consecutiveFailures;
    });

    return candidates[0];
  }
}

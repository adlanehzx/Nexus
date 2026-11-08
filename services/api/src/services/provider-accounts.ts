import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeConfigurationStore } from "./runtime-configuration.js";
import { ConflictError } from "./stores.js";

export const authStatusSchema = z.enum(["authenticated", "unauthenticated", "expired", "unknown"]);
export type AuthStatus = z.infer<typeof authStatusSchema>;

interface TokenFileData {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  project_id?: string;
}

interface QuotaBucket {
  bucketId?: string;
  window?: string;
  displayName?: string;
  description?: string;
  resetTime?: string;
  remainingFraction?: number;
}

interface QuotaSummaryResponse {
  groups?: { displayName?: string; buckets?: QuotaBucket[] }[];
  buckets?: QuotaBucket[];
}

export function resolveAntigravityTokenPath(
  account: ProviderAccount,
  sessionsDir?: string,
): string | null {
  const candidates: string[] = [];

  if (account.sessionDir && existsSync(account.sessionDir)) {
    candidates.push(
      join(account.sessionDir, "acp_token.json"),
      join(account.sessionDir, "antigravity-acp", "acp_token.json"),
    );
  }

  if (sessionsDir && existsSync(sessionsDir)) {
    candidates.push(
      join(sessionsDir, account.id, "acp_token.json"),
      join(sessionsDir, account.id, "antigravity-acp", "acp_token.json"),
    );
  }

  if (!sessionsDir) {
    const home = homedir();
    const t3Dirs = [
      join(home, ".t3", "userdata", "providers", "antigravity"),
      "/home/node/.t3/userdata/providers/antigravity",
    ];
    for (const d of t3Dirs) {
      if (existsSync(d)) {
        try {
          const instances = readdirSync(d, { withFileTypes: true });
          for (const inst of instances) {
            if (inst.isDirectory()) {
              candidates.push(join(d, inst.name, "antigravity-acp", "acp_token.json"));
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function fetchAntigravityQuotas(
  tokenPath: string,
): Promise<ProviderAccountQuotas | null> {
  if (!existsSync(tokenPath)) return null;
  let token: TokenFileData;
  try {
    token = JSON.parse(readFileSync(tokenPath, "utf8")) as TokenFileData;
  } catch {
    return null;
  }
  if (!token.client_id || !token.refresh_token) return null;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: token.client_id,
        client_secret: token.client_secret ?? "",
        refresh_token: token.refresh_token,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const oauth = (await res.json()) as { access_token?: string };
    if (!oauth.access_token) return null;

    const endpoints = [
      "https://daily-cloudcode-pa.googleapis.com",
      "https://cloudcode-pa.googleapis.com",
    ];

    let best5h: { fraction: number; resetTime?: string | undefined } | null = null;
    let bestWeek: { fraction: number; resetTime?: string | undefined } | null = null;

    for (const ep of endpoints) {
      try {
        const qRes = await fetch(`${ep}/v1internal:retrieveUserQuotaSummary`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${oauth.access_token}`,
            "User-Agent":
              "antigravity/hub/2.24.0 (aidev_client; os_type=linux; arch=x64; cl=963137146)",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(token.project_id ? { project: token.project_id } : {}),
          signal: AbortSignal.timeout(6000),
        });
        if (!qRes.ok) continue;
        const data = (await qRes.json()) as QuotaSummaryResponse;
        const buckets = (data.groups ?? [])
          .flatMap((g) => g.buckets ?? [])
          .concat(data.buckets ?? []);

        for (const b of buckets) {
          if (typeof b.remainingFraction !== "number") continue;
          if (b.window === "5h" || b.bucketId?.endsWith("-5h")) {
            if (best5h === null || b.remainingFraction < best5h.fraction) {
              best5h = {
                fraction: b.remainingFraction,
                ...(b.resetTime !== undefined ? { resetTime: b.resetTime } : {}),
              };
            }
          } else if (b.window === "weekly" || b.bucketId?.endsWith("-weekly")) {
            if (bestWeek === null || b.remainingFraction < bestWeek.fraction) {
              bestWeek = {
                fraction: b.remainingFraction,
                ...(b.resetTime !== undefined ? { resetTime: b.resetTime } : {}),
              };
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (best5h === null && bestWeek === null) return null;

    const resolved5hFraction =
      best5h !== null ? best5h.fraction : bestWeek !== null ? bestWeek.fraction : 1;
    const resolved5hReset =
      best5h?.resetTime ??
      (bestWeek?.resetTime ? new Date(Date.now() + 5 * 3600 * 1000).toISOString() : null);

    return {
      remaining5hPercent: Math.max(0, Math.min(100, Math.round(resolved5hFraction * 100))),
      resets5hAt: resolved5hReset,
      remainingWeekPercent:
        bestWeek !== null ? Math.max(0, Math.min(100, Math.round(bestWeek.fraction * 100))) : null,
      resetsWeekAt: bestWeek?.resetTime ?? null,
      exhausted:
        (best5h !== null && best5h.fraction <= 0) || (bestWeek !== null && bestWeek.fraction <= 0),
    };
  } catch {
    return null;
  }
}

export function probeClaudeAuth(account: ProviderAccount, sessionsDir?: string): AuthStatus {
  const candidates: string[] = [];
  if (account.sessionDir && existsSync(account.sessionDir)) {
    candidates.push(
      join(account.sessionDir, ".credentials.json"),
      join(account.sessionDir, ".claude", ".credentials.json"),
    );
  }
  if (!sessionsDir) {
    const home = homedir();
    candidates.push(
      join(home, ".claude", ".credentials.json"),
      "/home/node/.claude/.credentials.json",
    );
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const creds = JSON.parse(readFileSync(c, "utf8")) as {
          claudeAiOauth?: { accessToken?: string };
        };
        if (creds.claudeAiOauth?.accessToken) {
          return "authenticated";
        }
      } catch {
        // ignore
      }
    }
  }
  return account.authStatus;
}

export function probeCodexAuth(account: ProviderAccount, sessionsDir?: string): AuthStatus {
  const candidates: string[] = [];
  if (account.sessionDir && existsSync(account.sessionDir)) {
    candidates.push(
      join(account.sessionDir, "auth.json"),
      join(account.sessionDir, ".codex", "auth.json"),
      join(account.sessionDir, "config.toml"),
    );
  }
  if (!sessionsDir) {
    const home = homedir();
    candidates.push(
      join(home, ".codex", "auth.json"),
      "/home/node/.codex/auth.json",
      join(home, ".codex", "config.toml"),
      "/home/node/.codex/config.toml",
    );
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        if (c.endsWith(".json")) {
          const creds = JSON.parse(readFileSync(c, "utf8")) as {
            tokens?: { access_token?: string };
            OPENAI_API_KEY?: string;
            auth_mode?: string;
          };
          if (creds.tokens?.access_token || creds.OPENAI_API_KEY || creds.auth_mode === "chatgpt") {
            return "authenticated";
          }
        } else if (c.endsWith(".toml")) {
          const content = readFileSync(c, "utf8");
          if (
            content.includes("model") ||
            content.includes("chatgpt") ||
            content.includes("openai")
          ) {
            return "authenticated";
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return account.authStatus;
}

export function estimateObservedQuotas(
  provider: string,
  runs: { startTime: string; inputTokens: number; outputTokens: number }[],
  now: Date,
): ProviderAccountQuotas {
  const nowMs = now.getTime();
  const fiveHoursMs = 5 * 3600 * 1000;
  const sevenDaysMs = 7 * 24 * 3600 * 1000;

  const runs5h = runs.filter((r) => {
    const t = new Date(r.startTime).getTime();
    return !Number.isNaN(t) && nowMs - t <= fiveHoursMs && nowMs >= t;
  });
  const runs7d = runs.filter((r) => {
    const t = new Date(r.startTime).getTime();
    return !Number.isNaN(t) && nowMs - t <= sevenDaysMs && nowMs >= t;
  });

  const tokens5h = runs5h.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  const tokens7d = runs7d.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);

  const limit5h = provider === "claude" ? 250_000 : 300_000;
  const limit7d = provider === "claude" ? 1_200_000 : 1_500_000;

  const remaining5hPercent = Math.max(0, Math.min(100, Math.round((1 - tokens5h / limit5h) * 100)));
  const remainingWeekPercent = Math.max(
    0,
    Math.min(100, Math.round((1 - tokens7d / limit7d) * 100)),
  );

  const resets5hAt =
    runs5h.length > 0
      ? new Date(
          Math.min(...runs5h.map((r) => new Date(r.startTime).getTime())) + fiveHoursMs,
        ).toISOString()
      : new Date(nowMs + fiveHoursMs).toISOString();

  const resetsWeekAt =
    runs7d.length > 0
      ? new Date(
          Math.min(...runs7d.map((r) => new Date(r.startTime).getTime())) + sevenDaysMs,
        ).toISOString()
      : new Date(nowMs + sevenDaysMs).toISOString();

  return {
    remaining5hPercent,
    remainingWeekPercent,
    resets5hAt,
    resetsWeekAt,
    exhausted: remaining5hPercent <= 0 || remainingWeekPercent <= 0,
  };
}

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

export interface RunUsageStore {
  listAll(): Promise<
    {
      record: {
        model?: string | null;
        requestedModel?: string | null;
        startTime: string;
        usage: { inputTokens: number; outputTokens: number };
      };
    }[]
  >;
}

export interface ProviderAccountServiceOptions {
  runtimeConfiguration: RuntimeConfigurationStore;
  sessionsDir?: string;
  runStore?: RunUsageStore;
  now?: () => Date;
}

export class ProviderAccountService {
  readonly #config: RuntimeConfigurationStore;
  readonly #sessionsDir: string | undefined;
  readonly #runStore: RunUsageStore | undefined;
  readonly #now: () => Date;

  constructor(options: ProviderAccountServiceOptions) {
    this.#config = options.runtimeConfiguration;
    this.#sessionsDir = options.sessionsDir;
    this.#runStore = options.runStore;
    this.#now = options.now ?? (() => new Date());
  }

  /** Initialize with default accounts if the file does not exist yet. */
  defaultAccounts(): ProviderAccount[] {
    const timestamp = this.#now().toISOString();
    const baseDir = this.#sessionsDir ?? join(homedir(), ".nexus", "agents", "sessions");
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

    // Dynamically discover accounts from session directories in ~/.nexus/agents/sessions/*
    const baseDir = this.#sessionsDir ?? join(homedir(), ".nexus", "agents", "sessions");
    if (existsSync(baseDir)) {
      try {
        const entries = readdirSync(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const sessionId = entry.name;
          if (!/^[a-z][a-z0-9_-]{0,63}$/.test(sessionId)) continue;

          // Check if already registered
          if (accounts.some((acc) => acc.id === sessionId)) continue;

          // Infer provider from directory name prefix
          let provider = "antigravity";
          let profileKey = "antigravity";
          if (sessionId.startsWith("claude")) {
            provider = "claude";
            profileKey = "claude";
          } else if (sessionId.startsWith("codex")) {
            provider = "codex";
            profileKey = "default";
          } else if (sessionId.startsWith("agy") || sessionId.startsWith("antigravity")) {
            provider = "antigravity";
            profileKey = "antigravity";
          }

          const discoveredName = sessionId
            .split(/[-_]/)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ");

          const newAccount: ProviderAccount = {
            id: sessionId,
            provider,
            name: discoveredName,
            profileKey,
            sessionDir: join(baseDir, sessionId),
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
            metadata: { discovered: true },
            enabled: true,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          };

          accounts.push(newAccount);
          updated = true;
        }
      } catch {
        // Ignore filesystem read errors during discovery
      }
    }

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

    // Automatically probe and update quotas and auth status if never probed or older than 60s
    for (let i = 0; i < refreshed.length; i++) {
      const acc = refreshed[i];
      if (!acc) continue;
      const needsCheck =
        acc.lastCheckedAt === null ||
        acc.quotas.remaining5hPercent === null ||
        now.getTime() - new Date(acc.lastCheckedAt).getTime() > 60_000;
      if (needsCheck && acc.provider === "antigravity") {
        const tokenPath = resolveAntigravityTokenPath(acc, this.#sessionsDir);
        if (tokenPath) {
          const probedQuotas = await fetchAntigravityQuotas(tokenPath);
          if (probedQuotas) {
            refreshed[i] = {
              ...acc,
              quotas: probedQuotas,
              authStatus: "authenticated",
              lastCheckedAt: now.toISOString(),
              updatedAt: now.toISOString(),
            };
            updated = true;
          }
        }
      } else if (needsCheck && (acc.provider === "claude" || acc.provider === "codex")) {
        const auth =
          acc.provider === "claude"
            ? probeClaudeAuth(acc, this.#sessionsDir)
            : probeCodexAuth(acc, this.#sessionsDir);

        if (auth === "authenticated") {
          let quotas: ProviderAccountQuotas;
          if (this.#runStore) {
            const allStates = await this.#runStore.listAll().catch(() => []);
            const matchingRuns = allStates
              .filter((st) => {
                const m = (st.record.model ?? "").toLowerCase();
                const p = (st.record.requestedModel ?? "").toLowerCase();
                return (
                  m.includes(acc.provider) ||
                  p.includes(acc.provider) ||
                  (acc.provider === "codex" && (m.includes("gpt") || m.includes("openai")))
                );
              })
              .map((st) => ({
                startTime: st.record.startTime,
                inputTokens: st.record.usage?.inputTokens ?? 0,
                outputTokens: st.record.usage?.outputTokens ?? 0,
              }));
            quotas = estimateObservedQuotas(acc.provider, matchingRuns, now);
          } else {
            quotas = {
              remaining5hPercent: 100,
              remainingWeekPercent: 100,
              resets5hAt: new Date(now.getTime() + 5 * 3600 * 1000).toISOString(),
              resetsWeekAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
              exhausted: false,
            };
          }
          refreshed[i] = {
            ...acc,
            authStatus: "authenticated",
            quotas,
            lastCheckedAt: now.toISOString(),
            updatedAt: now.toISOString(),
          };
          updated = true;
        }
      }
    }

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
      throw new ConflictError(
        `Provider account "${validated.id}" already exists.`,
        "A provider account with this identifier already exists.",
      );
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

    const nowIso = this.#now().toISOString();
    let authStatus: AuthStatus = existing.authStatus;
    let quotas: ProviderAccountQuotas = existing.quotas;

    if (existing.provider === "antigravity") {
      const tokenPath = resolveAntigravityTokenPath(existing, this.#sessionsDir);
      if (tokenPath) {
        const probed = await fetchAntigravityQuotas(tokenPath);
        if (probed) {
          quotas = probed;
          authStatus = "authenticated";
        }
      }
    } else if (existing.provider === "claude") {
      const detected = probeClaudeAuth(existing, this.#sessionsDir);
      if (detected === "authenticated") {
        authStatus = "authenticated";
      }
    }

    if (existing.reliability.lastErrorCategory === "auth_required") {
      authStatus = "expired";
    } else if (
      existing.reliability.successCount > 0 &&
      existing.reliability.consecutiveFailures === 0
    ) {
      authStatus = "authenticated";
    } else if (authStatus === "unknown") {
      authStatus = "unknown";
    }

    const updated: ProviderAccount = {
      ...existing,
      authStatus,
      quotas,
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

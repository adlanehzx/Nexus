import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { pauseStateSchema, type PauseState } from "./pause.js";
import { mcpServerConfigSchema, type McpServerConfig } from "@nexus/mcp";
import { notificationsConfigSchema, type NotificationsConfig } from "@nexus/notifications";
import { providerAccountSchema, type ProviderAccount } from "./provider-accounts.js";
import { agentRoutingStatsSchema, type AgentRoutingStats } from "./agent-router.js";
import { osintCaseRecordSchema, type OsintCaseRecord } from "@nexus/osint";

const loopbackHttpUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  }, "Address must be a loopback HTTP URL");

const browserConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    enabled: z.boolean(),
    mode: z.literal("local-harness"),
    cdpUrl: loopbackHttpUrl,
  }),
  z.object({
    enabled: z.boolean(),
    mode: z.literal("remote-worker"),
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
        );
      }, "HTTP is restricted to loopback"),
    tokenRef: z.string().regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/),
  }),
]);

const persistedBrowserConfigSchema = z.union([
  browserConfigSchema,
  // Seamless migration from NEXUS 1.x configuration. The next
  // save from the dashboard will explicitly write the mode.
  z
    .object({
      enabled: z.boolean(),
      baseUrl: z.string().url(),
      tokenRef: z.string().regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/),
    })
    .transform((value) => ({ ...value, mode: "remote-worker" as const })),
]);

export type BrowserRuntimeConfig = z.infer<typeof browserConfigSchema>;

export const linkedInRuntimeConfigSchema = z.object({
  clientId: z.string().min(1).max(256),
  clientSecretRef: z.string().regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/),
  tokenRef: z.string().regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/),
  redirectUri: z
    .string()
    .url()
    .refine(
      (value) =>
        new URL(value).protocol === "https:" ||
        ["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname),
      "OAuth redirect must use HTTPS or loopback",
    ),
});

export type LinkedInRuntimeConfig = z.infer<typeof linkedInRuntimeConfigSchema>;

const sealedSecretSchema = z.object({
  iv: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

const encryptedSecretsSchema = z.object({
  version: z.literal(1),
  secrets: z.record(z.string(), sealedSecretSchema),
});

type EncryptedSecrets = z.infer<typeof encryptedSecretsSchema>;

export interface SecretVault {
  list(): Promise<string[]>;
  set(name: string, value: string): Promise<void>;
  get(ref: string): Promise<string | undefined>;
  delete(name: string): Promise<void>;
}

export class RuntimeConfigurationStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async loadMcp(): Promise<McpServerConfig[]> {
    const raw = await this.#read("mcp-servers.json", { servers: [] });
    return z.object({ servers: z.array(mcpServerConfigSchema) }).parse(raw).servers;
  }

  async saveMcp(servers: McpServerConfig[]): Promise<void> {
    await this.#write("mcp-servers.json", { servers });
  }

  async loadBrowser(): Promise<BrowserRuntimeConfig | null> {
    const raw = await this.#read("browser.json", null);
    return raw === null ? null : persistedBrowserConfigSchema.parse(raw);
  }

  async saveBrowser(config: BrowserRuntimeConfig): Promise<void> {
    await this.#write("browser.json", browserConfigSchema.parse(config));
  }

  async loadNotifications(): Promise<NotificationsConfig | null> {
    const raw = await this.#read("notifications.json", null);
    return raw === null ? null : notificationsConfigSchema.parse(raw);
  }

  async saveNotifications(config: NotificationsConfig): Promise<void> {
    await this.#write("notifications.json", notificationsConfigSchema.parse(config));
  }

  async loadLinkedIn(): Promise<LinkedInRuntimeConfig | null> {
    const raw = await this.#read("linkedin.json", null);
    return raw === null ? null : linkedInRuntimeConfigSchema.parse(raw);
  }

  async saveLinkedIn(config: LinkedInRuntimeConfig): Promise<void> {
    await this.#write("linkedin.json", linkedInRuntimeConfigSchema.parse(config));
  }

  async loadProviderAccounts(): Promise<ProviderAccount[] | null> {
    const raw = await this.#read("provider-accounts.json", null);
    return raw === null ? null : z.array(providerAccountSchema).parse(raw);
  }

  async saveProviderAccounts(accounts: ProviderAccount[]): Promise<void> {
    await this.#write("provider-accounts.json", z.array(providerAccountSchema).parse(accounts));
  }

  async loadPause(): Promise<PauseState | null> {
    const raw = await this.#read("pause.json", null);
    return raw === null ? null : pauseStateSchema.parse(raw);
  }

  async savePause(state: PauseState): Promise<void> {
    await this.#write("pause.json", pauseStateSchema.parse(state));
  }

  async loadRoutingStats(): Promise<AgentRoutingStats | null> {
    const raw = await this.#read("agent-routing-stats.json", null);
    return raw === null ? null : agentRoutingStatsSchema.parse(raw);
  }

  async saveRoutingStats(stats: AgentRoutingStats): Promise<void> {
    await this.#write("agent-routing-stats.json", agentRoutingStatsSchema.parse(stats));
  }

  async loadOsintCases(): Promise<OsintCaseRecord[]> {
    const raw = await this.#read("osint-cases.json", { cases: [] });
    return z.object({ cases: z.array(osintCaseRecordSchema) }).parse(raw).cases;
  }

  async saveOsintCases(cases: OsintCaseRecord[]): Promise<void> {
    await this.#write("osint-cases.json", {
      cases: z.array(osintCaseRecordSchema).parse(cases),
    });
  }

  async listSecretNames(): Promise<string[]> {
    const raw = await this.#read("secret-refs.json", { names: [] });
    return z
      .object({ names: z.array(z.string()) })
      .parse(raw)
      .names.sort();
  }

  async saveSecretNames(names: string[]): Promise<void> {
    await this.#write("secret-refs.json", { names: [...new Set(names)].sort() });
  }

  async loadEncryptedSecrets(): Promise<EncryptedSecrets> {
    return encryptedSecretsSchema.parse(
      await this.#read("secrets.enc.json", { version: 1, secrets: {} }),
    );
  }

  async saveEncryptedSecrets(value: EncryptedSecrets): Promise<void> {
    await this.#write("secrets.enc.json", encryptedSecretsSchema.parse(value));
  }

  async #read(name: string, fallback: unknown): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.#directory, name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  async #write(name: string, value: unknown): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const path = join(this.#directory, name);
    // A PID only identifies the process, not an individual write. Dashboard
    // startup issues several reads concurrently and some of them initialise the
    // same configuration file. Reusing one temporary path lets the first rename
    // remove the file underneath the other writer. A per-write nonce preserves
    // atomic rename semantics without serialising unrelated configuration files.
    const temporary = join(this.#directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await copyFile(path, `${path}.bak-${new Date().toISOString().replaceAll(/[:.]/g, "")}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }
}

export class KeyringVault implements SecretVault {
  readonly #store: RuntimeConfigurationStore;

  constructor(store: RuntimeConfigurationStore) {
    this.#store = store;
  }

  async list(): Promise<string[]> {
    return this.#store.listSecretNames();
  }

  async set(name: string, value: string): Promise<void> {
    const key = secretName(name);
    if (value.length < 4 || value.length > 16_384) throw new Error("Invalid secret value.");
    await runSecretTool(["store", `--label=NEXUS · ${key}`, "service", "nexus", "key", key], value);
    await this.#store.saveSecretNames([...(await this.list()), key]);
  }

  async get(ref: string): Promise<string | undefined> {
    const key = referenceName(ref);
    const value = await runSecretTool(["lookup", "service", "nexus", "key", key]).catch(() => "");
    return value.trim().length === 0 ? undefined : value.trimEnd();
  }

  async delete(name: string): Promise<void> {
    const key = secretName(name);
    await runSecretTool(["clear", "service", "nexus", "key", key]).catch(() => "");
    await this.#store.saveSecretNames((await this.list()).filter((item) => item !== key));
  }
}

/**
 * Persistent fallback for headless and container installations where no desktop
 * Secret Service is available. Values are encrypted independently with AES-256-GCM;
 * only ciphertext, nonces and authentication tags reach the runtime volume.
 */
export class EncryptedFileVault implements SecretVault {
  readonly #store: RuntimeConfigurationStore;
  readonly #key: Buffer;

  constructor(store: RuntimeConfigurationStore, masterSecret: string) {
    if (masterSecret.trim().length < 32) {
      throw new Error("MASTER_KEY must contain at least 32 characters.");
    }
    this.#store = store;
    this.#key = createHash("sha256").update(masterSecret, "utf8").digest();
  }

  async list(): Promise<string[]> {
    return Object.keys((await this.#store.loadEncryptedSecrets()).secrets).sort();
  }

  async set(name: string, value: string): Promise<void> {
    const key = secretName(name);
    if (value.length < 4 || value.length > 16_384) throw new Error("Invalid secret value.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(key, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const current = await this.#store.loadEncryptedSecrets();
    current.secrets[key] = {
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    await this.#store.saveEncryptedSecrets(current);
    await this.#store.saveSecretNames(Object.keys(current.secrets));
  }

  async get(ref: string): Promise<string | undefined> {
    const key = referenceName(ref);
    const sealed = (await this.#store.loadEncryptedSecrets()).secrets[key];
    if (sealed === undefined) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(key, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  async delete(name: string): Promise<void> {
    const key = secretName(name);
    const current = await this.#store.loadEncryptedSecrets();
    delete current.secrets[key];
    await this.#store.saveEncryptedSecrets(current);
    await this.#store.saveSecretNames(Object.keys(current.secrets));
  }
}

function secretName(value: string): string {
  return z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .parse(value);
}

function referenceName(ref: string): string {
  const match = /^vault:\/\/nexus\/([a-z][a-z0-9_-]{0,63})$/.exec(ref);
  if (match?.[1] === undefined) throw new Error("Invalid secret reference.");
  return match[1];
}

function runSecretTool(args: string[], stdin = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-16_384);
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Local keyring is unavailable (${String(code)}).`));
    });
    child.stdin.end(stdin);
  });
}

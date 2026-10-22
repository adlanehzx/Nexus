import { spawn } from "node:child_process";
import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { pauseStateSchema, type PauseState } from "./pause.js";
import { mcpServerConfigSchema, type McpServerConfig } from "@nexus/mcp";
import { notificationsConfigSchema, type NotificationsConfig } from "@nexus/notifications";
import { providerAccountSchema, type ProviderAccount } from "./provider-accounts.js";
import { agentRoutingStatsSchema, type AgentRoutingStats } from "./agent-router.js";

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
    const temporary = join(this.#directory, `.${name}.${process.pid}.tmp`);
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

export class KeyringVault {
  readonly #store: RuntimeConfigurationStore;

  constructor(store: RuntimeConfigurationStore) {
    this.#store = store;
  }

  async list(): Promise<string[]> {
    return this.#store.listSecretNames();
  }

  async set(name: string, value: string): Promise<void> {
    const key = secretName(name);
    if (value.length < 4 || value.length > 16_384) throw new Error("Valeur de secret invalide.");
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

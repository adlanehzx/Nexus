import { request, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Home Assistant supervisor: the only NEXUS process that talks to Docker.
 *
 * The API container is read-only, has no capabilities and never sees the
 * Docker socket. Turning the bundled Home Assistant on or off from the
 * dashboard goes through this small process instead, which can do exactly
 * four things to exactly one container:
 *
 *   status   — is it there, running, how much memory does it use
 *   enable   — pull the pinned image if missing, create the container if
 *              missing, start it
 *   disable  — stop it (configuration volume kept)
 *
 * Container name, image, volume and memory cap are fixed at startup; nothing
 * in a request can change them. It listens on a Unix socket shared only with
 * the API container, so there is no port and no token to configure.
 *
 * No dependency beyond Node built-ins: it runs on a plain `node` image.
 */

export interface DockerEngine {
  call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
  /** Streams newline-delimited JSON (image pull progress). Resolves with the HTTP status. */
  stream(
    method: "POST",
    path: string,
    onLine: (line: Record<string, unknown>) => void,
  ): Promise<number>;
}

export function unixDockerEngine(
  socketPath = "/var/run/docker.sock",
  apiVersion = "v1.43",
): DockerEngine {
  const send = (
    method: string,
    path: string,
    body: unknown,
    onData: (res: IncomingMessage) => void,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath,
          method,
          path: `/${apiVersion}${path}`,
          headers:
            payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                },
        },
        (res) => {
          onData(res);
          res.on("end", () => resolve());
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.setTimeout(30 * 60_000, () => req.destroy(new Error("docker request timed out")));
      req.end(payload);
    });

  return {
    async call(method, path, body) {
      let status = 0;
      const chunks: Buffer[] = [];
      await send(method, path, body, (res) => {
        status = res.statusCode ?? 0;
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
      });
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown = text;
      try {
        parsed = text.length === 0 ? null : JSON.parse(text);
      } catch {
        // plain text body
      }
      return { status, body: parsed };
    },
    async stream(method, path, onLine) {
      let status = 0;
      let buffered = "";
      await send(method, path, undefined, (res) => {
        status = res.statusCode ?? 0;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffered += chunk;
          let index = buffered.indexOf("\n");
          while (index !== -1) {
            const line = buffered.slice(0, index).trim();
            buffered = buffered.slice(index + 1);
            if (line !== "") {
              try {
                onLine(JSON.parse(line) as Record<string, unknown>);
              } catch {
                // ignore malformed progress line
              }
            }
            index = buffered.indexOf("\n");
          }
        });
      });
      return status;
    },
  };
}

export interface BundledHomeAssistantSpec {
  readonly containerName: string;
  /** `registry/repo:tag` */
  readonly image: string;
  /** Docker volume holding `/config`; shared with the compose `home` profile. */
  readonly volume: string;
  readonly memoryLimitBytes: number;
}

export const DEFAULT_SPEC: BundledHomeAssistantSpec = {
  containerName: "nexus-homeassistant",
  image: "ghcr.io/home-assistant/home-assistant:2026.10.4",
  volume: "nexus_homeassistant-config",
  memoryLimitBytes: 1024 * 1024 * 1024,
};

const IMAGE_REF = /^[a-z0-9][a-z0-9./_-]{0,200}:[A-Za-z0-9._-]{1,128}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export function validateSpec(spec: BundledHomeAssistantSpec): BundledHomeAssistantSpec {
  if (!IMAGE_REF.test(spec.image))
    throw new Error(`Invalid Home Assistant image reference: ${spec.image}`);
  if (!NAME.test(spec.containerName) || !NAME.test(spec.volume))
    throw new Error("Invalid container or volume name.");
  if (!Number.isInteger(spec.memoryLimitBytes) || spec.memoryLimitBytes < 256 * 1024 * 1024) {
    throw new Error("Memory limit must be at least 256 MiB.");
  }
  return spec;
}

export type BundledState =
  "absent" | "pulling" | "starting" | "running" | "stopping" | "stopped" | "error";

export interface BundledStatus {
  readonly state: BundledState;
  readonly image: string;
  readonly memoryUsageBytes: number | null;
  readonly memoryLimitBytes: number;
  readonly pull: { readonly currentBytes: number; readonly totalBytes: number } | null;
  readonly startedAt: string | null;
  readonly error: string | null;
}

export class HomeAssistantSupervisor {
  readonly #engine: DockerEngine;
  readonly #spec: BundledHomeAssistantSpec;
  #busy: "pulling" | "starting" | "stopping" | null = null;
  #pull: Map<string, { current: number; total: number }> | null = null;
  #error: string | null = null;

  constructor(engine: DockerEngine, spec: BundledHomeAssistantSpec = DEFAULT_SPEC) {
    this.#engine = engine;
    this.#spec = validateSpec(spec);
  }

  async status(): Promise<BundledStatus> {
    const name = encodeURIComponent(this.#spec.containerName);
    const inspect = await this.#engine.call("GET", `/containers/${name}/json`);
    const state = inspect.body as { State?: { Running?: boolean; StartedAt?: string } } | null;
    const running = inspect.status === 200 && state?.State?.Running === true;
    let memory: number | null = null;
    if (running) {
      const stats = await this.#engine.call(
        "GET",
        `/containers/${name}/stats?stream=false&one-shot=true`,
      );
      const m = (
        stats.body as { memory_stats?: { usage?: number; stats?: Record<string, number> } } | null
      )?.memory_stats;
      if (typeof m?.usage === "number") {
        // Same figure as `docker stats`: usage minus reclaimable page cache.
        const cache = m.stats?.inactive_file ?? m.stats?.cache ?? 0;
        memory = Math.max(0, m.usage - cache);
      }
    }
    const pull = this.#pull === null ? null : this.#pullTotals();
    const base: BundledState =
      this.#busy ?? (inspect.status === 404 ? "absent" : running ? "running" : "stopped");
    return {
      state: this.#error !== null && this.#busy === null && !running ? "error" : base,
      image: this.#spec.image,
      memoryUsageBytes: memory,
      memoryLimitBytes: this.#spec.memoryLimitBytes,
      pull,
      startedAt:
        running && typeof state?.State?.StartedAt === "string" ? state.State.StartedAt : null,
      error: this.#error,
    };
  }

  /** Starts the work and returns at once; progress is visible through `status`. */
  async enable(): Promise<BundledStatus> {
    if (this.#busy === null) {
      this.#error = null;
      this.#busy = "starting";
      void this.#bringUp().finally(() => {
        this.#busy = null;
        this.#pull = null;
      });
    }
    return this.status();
  }

  async disable(): Promise<BundledStatus> {
    if (this.#busy !== null) return this.status();
    this.#error = null;
    this.#busy = "stopping";
    try {
      const name = encodeURIComponent(this.#spec.containerName);
      const result = await this.#engine.call("POST", `/containers/${name}/stop?t=30`);
      if (result.status !== 204 && result.status !== 304 && result.status !== 404) {
        this.#error = `Docker refused to stop Home Assistant (HTTP ${String(result.status)}).`;
      }
    } catch (error) {
      this.#error = describe(error);
    } finally {
      this.#busy = null;
    }
    return this.status();
  }

  async #bringUp(): Promise<void> {
    const spec = this.#spec;
    const name = encodeURIComponent(spec.containerName);
    try {
      // The reference is validated at startup (no `?`, `#` or spaces): Docker
      // expects its slashes and colon literally in the path.
      const image = await this.#engine.call("GET", `/images/${spec.image}/json`);
      if (image.status === 404) {
        this.#busy = "pulling";
        this.#pull = new Map();
        const separator = spec.image.lastIndexOf(":");
        const repo = spec.image.slice(0, separator);
        const tag = spec.image.slice(separator + 1);
        let failure: string | null = null;
        const status = await this.#engine.stream(
          "POST",
          `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
          (line) => {
            if (typeof line.error === "string") failure = line.error;
            const id = typeof line.id === "string" ? line.id : null;
            const detail = line.progressDetail as { current?: number; total?: number } | undefined;
            if (id !== null && typeof detail?.total === "number") {
              this.#pull?.set(id, { current: detail.current ?? 0, total: detail.total });
            }
          },
        );
        if (status !== 200 || failure !== null) {
          throw new Error(failure ?? `image download failed (HTTP ${String(status)})`);
        }
        this.#busy = "starting";
      }
      const existing = await this.#engine.call("GET", `/containers/${name}/json`);
      if (existing.status === 404) {
        const created = await this.#engine.call("POST", `/containers/create?name=${name}`, {
          Image: spec.image,
          Labels: { "dev.nexus.managed-by": "home-supervisor" },
          HostConfig: {
            // mDNS, SSDP, HomeKit and Cast discovery need the LAN broadcast domain.
            NetworkMode: "host",
            RestartPolicy: { Name: "unless-stopped" },
            Binds: [`${spec.volume}:/config`, "/etc/localtime:/etc/localtime:ro"],
            Memory: spec.memoryLimitBytes,
            SecurityOpt: ["no-new-privileges:true"],
          },
        });
        if (created.status !== 201) {
          throw new Error(
            `Docker refused to create Home Assistant (HTTP ${String(created.status)}).`,
          );
        }
      }
      const started = await this.#engine.call("POST", `/containers/${name}/start`);
      if (started.status !== 204 && started.status !== 304) {
        throw new Error(`Docker refused to start Home Assistant (HTTP ${String(started.status)}).`);
      }
    } catch (error) {
      this.#error = describe(error);
    }
  }

  #pullTotals(): { currentBytes: number; totalBytes: number } {
    let current = 0;
    let total = 0;
    for (const layer of this.#pull?.values() ?? []) {
      current += Math.min(layer.current, layer.total);
      total += layer.total;
    }
    return { currentBytes: current, totalBytes: total };
  }
}

function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "EACCES") {
    return "The Docker socket is not reachable by the supervisor.";
  }
  return error instanceof Error ? error.message.slice(0, 200) : "unknown error";
}

/** HTTP surface on the private Unix socket: three fixed routes, no input. */
export function supervisorHandler(supervisor: HomeAssistantSupervisor) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const route = `${req.method ?? ""} ${req.url ?? ""}`;
    const action =
      route === "GET /status"
        ? () => supervisor.status()
        : route === "POST /enable"
          ? () => supervisor.enable()
          : route === "POST /disable"
            ? () => supervisor.disable()
            : undefined;
    req.resume();
    if (action === undefined) {
      reply(404, { error: "not_found" });
      return;
    }
    action().then(
      (status) => reply(200, status),
      (error: unknown) => reply(502, { error: describe(error) }),
    );
  };
}

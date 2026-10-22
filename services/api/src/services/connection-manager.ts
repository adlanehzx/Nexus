import {
  ConnectionDetector,
  NodePackageResolver,
  NodeProcessPort,
  SafeCommandRunner,
  SystemClock,
  createBuiltInRegistry,
  extendEnvAllowlist,
  type Connection,
  type ConnectionAction,
  type ConnectionKind,
  type ConnectionPlatform,
  type ProviderRegistry,
} from "@nexus/connections";

/** Safe, secret-free provider metadata returned to administrator surfaces. */
export interface ConnectionCatalogEntry {
  providerId: string;
  displayName: string;
  kind: ConnectionKind;
  platforms: ConnectionPlatform[];
  supportedOnThisHost: boolean;
  actions: ConnectionAction[];
  docsUrl: string | null;
  adapter: {
    provenance: "official" | "community" | "unknown";
    provenanceEvidence: string;
  };
  observation: Connection | null;
}

export interface ConnectionCatalogService {
  list(): ConnectionCatalogEntry[];
  detectAll(): Promise<ConnectionCatalogEntry[]>;
  test(providerId: string): Promise<ConnectionCatalogEntry>;
}

/**
 * Host-local connection discovery.
 *
 * It deliberately stores observations only in memory: installation, session,
 * and quota health are live facts rather than durable configuration. A restart
 * returns them to unknown until the next explicit scan instead of displaying a
 * stale green state.
 */
export class LocalConnectionManager implements ConnectionCatalogService {
  readonly #registry: ProviderRegistry;
  readonly #detector: ConnectionDetector;
  readonly #platform: ConnectionPlatform;
  readonly #observed = new Map<string, Connection>();
  #tail: Promise<void> = Promise.resolve();

  constructor(
    options: {
      registry?: ProviderRegistry;
      detector?: ConnectionDetector;
      platform?: ConnectionPlatform;
    } = {},
  ) {
    this.#platform = options.platform ?? connectionPlatform(process.platform);
    this.#registry = options.registry ?? createBuiltInRegistry();

    if (options.detector !== undefined) {
      this.#detector = options.detector;
      return;
    }

    const clock = new SystemClock();
    this.#detector = new ConnectionDetector({
      registry: this.#registry,
      runner: new SafeCommandRunner({
        process: new NodeProcessPort({ platform: process.platform }),
        clock,
        // Hosts whose agent CLIs are version-manager shims need a few extra
        // ordinary variables for those shims to run at all; without them the
        // probe times out on a tool that works. Secret-shaped names are still
        // stripped, so this cannot be used to hand a token to a child.
        envAllowlist: extendEnvAllowlist(process.env.NEXUS_PROBE_ENV_ALLOWLIST),
      }),
      clock,
      platform: this.#platform,
      // Finds ACP adapter packages on disk. Without it adapter availability
      // would stay `unknown` for every provider, which is honest but useless.
      // The resolver reads directory entries; it never loads an adapter.
      packages: new NodePackageResolver(),
      // SafeCommandRunner applies a strict allowlist and strips secret-shaped
      // names before any child process receives this ambient environment.
      env: process.env,
    });
  }

  list(): ConnectionCatalogEntry[] {
    return this.#registry.list().map((definition) => ({
      providerId: definition.id,
      displayName: definition.displayName,
      kind: definition.kind,
      platforms: [...definition.platforms],
      supportedOnThisHost: definition.platforms.includes(this.#platform),
      actions: [...definition.actions],
      docsUrl: definition.docsUrl ?? null,
      adapter: {
        provenance: definition.adapter.provenance,
        provenanceEvidence: definition.adapter.provenanceEvidence,
      },
      observation: this.#observed.get(definition.id) ?? null,
    }));
  }

  detectAll(): Promise<ConnectionCatalogEntry[]> {
    return this.#serial(async () => {
      const observations = await this.#detector.detectAll(this.#observed);
      for (const observation of observations) {
        this.#observed.set(observation.providerId, observation);
      }
      return this.list();
    });
  }

  test(providerId: string): Promise<ConnectionCatalogEntry> {
    return this.#serial(async () => {
      // Detector resolves the id through the closed registry before running
      // anything. A request can select a provider, never a command or argv.
      const observation = await this.#detector.detect(providerId, this.#observed.get(providerId));
      this.#observed.set(providerId, observation);
      const entry = this.list().find((candidate) => candidate.providerId === providerId);
      if (entry === undefined) throw new Error("Connection disappeared from its registry.");
      return entry;
    });
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function connectionPlatform(platform: NodeJS.Platform): ConnectionPlatform {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return platform;
  return "unknown";
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const tailscalePeerSchema = z.object({
  ID: z.string().optional(),
  HostName: z.string().optional(),
  DNSName: z.string().optional(),
  OS: z.string().optional(),
  Online: z.boolean().optional(),
  Active: z.boolean().optional(),
  TailscaleIPs: z.array(z.string()).optional(),
});

const tailscaleStatusSchema = z.object({
  BackendState: z.string().optional(),
  MagicDNSSuffix: z.string().optional(),
  Self: tailscalePeerSchema.optional(),
  Peer: z.record(z.string(), tailscalePeerSchema).optional(),
});

export interface TailscalePeer {
  id: string;
  name: string;
  dnsName?: string;
  os: string;
  online: boolean;
  active: boolean;
  ipv4?: string;
}

export interface TailscaleDiscovery {
  installed: boolean;
  running: boolean;
  backendState: string;
  tailnet?: string;
  suggestedApiUrl?: string;
  self?: TailscalePeer;
  peers: TailscalePeer[];
  guidance: string;
}

export type TailscaleCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

const defaultRunner: TailscaleCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, [...args], {
    timeout: 3_000,
    maxBuffer: 1_048_576,
    windowsHide: true,
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
  });
  return { stdout: result.stdout };
};

/**
 * Read-only inventory of the local Tailscale node and its visible peers.
 *
 * Commands and arguments are fixed, no shell is involved, stderr is never
 * returned to clients, and Tailscale authentication material is not read.
 */
export class TailscaleDiscoveryService {
  readonly #run: TailscaleCommandRunner;
  readonly #apiPort: number;

  constructor(options: { run?: TailscaleCommandRunner; apiPort?: number } = {}) {
    this.#run = options.run ?? defaultRunner;
    this.#apiPort = options.apiPort ?? 3000;
  }

  async inspect(): Promise<TailscaleDiscovery> {
    try {
      await this.#run("tailscale", ["version"]);
    } catch {
      return {
        installed: false,
        running: false,
        backendState: "NotInstalled",
        peers: [],
        guidance: "Install Tailscale on the NEXUS host to discover private-network devices.",
      };
    }

    let raw: string;
    try {
      raw = (await this.#run("tailscale", ["status", "--json"])).stdout;
    } catch {
      return {
        installed: true,
        running: false,
        backendState: "Stopped",
        peers: [],
        guidance: "Tailscale is installed but is not connected.",
      };
    }

    try {
      const status = tailscaleStatusSchema.parse(JSON.parse(raw));
      const self = status.Self === undefined ? undefined : presentPeer("self", status.Self);
      const running = status.BackendState === "Running" && self !== undefined;
      const ipv4 = self?.ipv4;
      const dnsName = self?.dnsName?.replace(/\.$/, "");
      // Prefer MagicDNS: it remains stable when Tailscale rotates an address,
      // and the dashboard CSP can allow the private *.ts.net namespace without
      // permitting arbitrary clear-text HTTP destinations.
      const host = dnsName ?? ipv4;
      return {
        installed: true,
        running,
        backendState: status.BackendState ?? "Unknown",
        ...(status.MagicDNSSuffix === undefined ? {} : { tailnet: status.MagicDNSSuffix }),
        ...(running && host !== undefined
          ? { suggestedApiUrl: `http://${host}:${String(this.#apiPort)}` }
          : {}),
        ...(self === undefined ? {} : { self }),
        peers: Object.entries(status.Peer ?? {})
          .map(([id, peer]) => presentPeer(id, peer))
          .sort(
            (left, right) =>
              Number(right.online) - Number(left.online) || left.name.localeCompare(right.name),
          ),
        guidance: running
          ? "Tailscale is connected. NEXUS automatically uses its private address for new pairing tickets when PUBLIC_API_URL is not set."
          : "Tailscale is present but has no active private address.",
      };
    } catch {
      return {
        installed: true,
        running: false,
        backendState: "InvalidStatus",
        peers: [],
        guidance: "Tailscale returned an unreadable status response.",
      };
    }
  }

  async publicApiUrl(): Promise<string | undefined> {
    return (await this.inspect()).suggestedApiUrl;
  }
}

function presentPeer(id: string, peer: z.infer<typeof tailscalePeerSchema>): TailscalePeer {
  const dnsName = peer.DNSName?.replace(/\.$/, "");
  const ipv4 = peer.TailscaleIPs?.find((address) => address.startsWith("100."));
  return {
    id: peer.ID ?? id,
    name: peer.HostName ?? dnsName ?? "Unknown device",
    ...(dnsName === undefined ? {} : { dnsName }),
    os: peer.OS ?? "unknown",
    online: peer.Online ?? false,
    active: peer.Active ?? false,
    ...(ipv4 === undefined ? {} : { ipv4 }),
  };
}

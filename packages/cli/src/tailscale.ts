import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  ip?: string | undefined;
  dnsName?: string | undefined;
  tailnet?: string | undefined;
  suggestedUrl?: string | undefined;
  guidance: string;
}

export type CommandExecutor = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultExecutor: CommandExecutor = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 3_000 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: unknown) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? Number((err as { code?: unknown }).code) || 1
        : 1;
    const stdout =
      typeof err === "object" &&
      err !== null &&
      "stdout" in err &&
      typeof (err as { stdout?: unknown }).stdout === "string"
        ? (err as { stdout: string }).stdout
        : "";
    const stderr =
      typeof err === "object" &&
      err !== null &&
      "stderr" in err &&
      typeof (err as { stderr?: unknown }).stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
    return { stdout, stderr, exitCode: code };
  }
};

/**
 * Probes the local machine for Tailscale status and network addresses.
 *
 * This operation is strictly read-only and non-blocking. It detects whether
 * Tailscale is active and can provide a zero-configuration private tunnel
 * for mobile devices and remote workers without port forwarding.
 */
export async function detectTailscale(
  executor: CommandExecutor = defaultExecutor,
  apiPort = 3000,
): Promise<TailscaleInfo> {
  // 1. Check if tailscale CLI is available
  const versionCheck = await executor("tailscale", ["version"]);
  if (versionCheck.exitCode !== 0) {
    return {
      installed: false,
      running: false,
      guidance:
        "Tailscale is not installed. NEXUS will use standard local/LAN networking. If you wish to connect mobile devices or remote workers without firewall port forwarding, install Tailscale from https://tailscale.com.",
    };
  }

  // 2. Check tailscale daemon status and retrieve network information
  const statusCheck = await executor("tailscale", ["status", "--json"]);
  if (statusCheck.exitCode !== 0) {
    return {
      installed: true,
      running: false,
      guidance:
        "Tailscale CLI is installed, but the Tailscale service is stopped or not logged in. Start it with 'sudo tailscale up' to enable remote connectivity.",
    };
  }

  try {
    const data = JSON.parse(statusCheck.stdout) as {
      Self?: {
        DNSName?: string;
        TailscaleIPs?: string[];
      };
      MagicDNSSuffix?: string;
    };

    const ips = data.Self?.TailscaleIPs ?? [];
    const ipv4 = ips.find((ip) => ip.startsWith("100."));
    const rawDns = data.Self?.DNSName?.replace(/\.$/, "");

    if (!ipv4 && !rawDns) {
      return {
        installed: true,
        running: false,
        guidance:
          "Tailscale is running but no active Tailscale IP was found. Ensure your machine is authenticated to your tailnet.",
      };
    }

    const suggestedUrl = ipv4 ? `http://${ipv4}:${apiPort}` : `http://${rawDns}:${apiPort}`;

    return {
      installed: true,
      running: true,
      ip: ipv4,
      dnsName: rawDns,
      tailnet: data.MagicDNSSuffix,
      suggestedUrl,
      guidance:
        "Tailscale connection active. Your tailnet IP allows mobile clients and workers to communicate securely with NEXUS from outside your local Wi-Fi without opening ports to the public internet.",
    };
  } catch {
    // If JSON parsing fails, fall back to simple IPv4 check
    const ipCheck = await executor("tailscale", ["ip", "-4"]);
    if (ipCheck.exitCode === 0 && ipCheck.stdout.startsWith("100.")) {
      const ipv4 = ipCheck.stdout.split("\n")[0]?.trim();
      return {
        installed: true,
        running: true,
        ip: ipv4,
        suggestedUrl: `http://${ipv4}:${apiPort}`,
        guidance:
          "Tailscale connection active. Mobile and remote workers can connect via your encrypted Tailscale IP.",
      };
    }

    return {
      installed: true,
      running: false,
      guidance: "Tailscale is installed but active network addresses could not be parsed.",
    };
  }
}

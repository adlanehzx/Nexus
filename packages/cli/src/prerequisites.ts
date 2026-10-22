import { createServer } from "node:net";

export interface SystemPrerequisites {
  nodeVersion: {
    current: string;
    meetsRequirement: boolean;
    required: string;
  };
  pnpm: {
    installed: boolean;
    version?: string | undefined;
  };
  docker: {
    installed: boolean;
    daemonRunning: boolean;
    details?: string | undefined;
  };
  ports: {
    port: number;
    name: string;
    available: boolean;
  }[];
  allMet: boolean;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

/**
 * Checks whether a local TCP port is currently free to bind.
 */
export async function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Validates that current Node.js version satisfies >= 22.13.0.
 */
export function checkNodeVersion(version = process.version): {
  current: string;
  meetsRequirement: boolean;
  required: string;
} {
  const clean = version.replace(/^v/, "");
  const [major = 0, minor = 0] = clean.split(".").map(Number);
  const meets = major > 22 || (major === 22 && minor >= 13);
  return {
    current: version,
    meetsRequirement: meets,
    required: ">= 22.13.0",
  };
}

/**
 * Verifies all system prerequisites for running NEXUS.
 */
export async function checkPrerequisites(
  runner?: CommandRunner,
  portsToCheck = [
    { port: 3000, name: "NEXUS API" },
    { port: 8080, name: "Dashboard" },
    { port: 15432, name: "PostgreSQL" },
    { port: 6379, name: "Redis" },
  ],
): Promise<SystemPrerequisites> {
  const nodeCheck = checkNodeVersion();

  let pnpmInstalled = false;
  let pnpmVersion: string | undefined;

  let dockerInstalled = false;
  let dockerDaemonRunning = false;
  let dockerDetails: string | undefined;

  if (runner) {
    const pnpmRes = await runner("pnpm", ["--version"]);
    if (pnpmRes.exitCode === 0) {
      pnpmInstalled = true;
      pnpmVersion = pnpmRes.stdout.trim();
    }

    const dockerVersionRes = await runner("docker", ["--version"]);
    if (dockerVersionRes.exitCode === 0) {
      dockerInstalled = true;
      const dockerInfoRes = await runner("docker", ["info"]);
      if (dockerInfoRes.exitCode === 0) {
        dockerDaemonRunning = true;
        dockerDetails = dockerVersionRes.stdout.trim();
      } else {
        dockerDetails = "Docker installed, but daemon is not responding";
      }
    }
  }

  const portResults: { port: number; name: string; available: boolean }[] = [];
  for (const item of portsToCheck) {
    const available = await isPortAvailable(item.port);
    portResults.push({ port: item.port, name: item.name, available });
  }

  // Node version is mandatory. If checking ports, unavailable ports may be existing NEXUS services.
  const allMet = nodeCheck.meetsRequirement;

  return {
    nodeVersion: nodeCheck,
    pnpm: {
      installed: pnpmInstalled,
      version: pnpmVersion,
    },
    docker: {
      installed: dockerInstalled,
      daemonRunning: dockerDaemonRunning,
      details: dockerDetails,
    },
    ports: portResults,
    allMet,
  };
}

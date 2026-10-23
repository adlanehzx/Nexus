#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ConnectionDetector,
  NodeProcessPort,
  SafeCommandRunner,
  SystemClock,
  createBuiltInRegistry,
} from "@nexus/connections";
import {
  initConnector,
  registerClientKey,
  revokeClientKey,
  setClientEnabled,
  connectorStatus,
} from "./admin.js";
import { RequestAuthenticator } from "./auth.js";
import { authenticatorClientsFrom, readConnectorConfig } from "./config.js";
import { startConnector, type ConnectorListenTarget } from "./http.js";
import { FileNoncePersistence } from "./nonce-log.js";
import { ConnectorServer } from "./server.js";

function logOut(msg: string): void {
  process.stdout.write(msg + "\n");
}

function printUsage(): void {
  logOut(`Usage: nexus-connector <command> [options]

Commands:
  start          Start the local connector daemon
  init           Initialize an empty connector configuration
  status         Show registered clients and key fingerprints
  add-key        Register a client public key for authentication
  revoke-key     Revoke a public key by fingerprint
  set-enabled    Enable or disable a client

Options for 'start':
  --config <path>    Path to connector configuration file
  --socket <path>    Path to Unix domain socket
  --port <number>    Port for loopback TCP transport
  --data-dir <path>  Directory for state and nonce persistence (mode 0700)
`);
}

function parseArgs(args: string[]): {
  command: string;
  flags: Record<string, string>;
} {
  const command = args[0] ?? "help";
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return { command, flags };
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  if (process.platform === "win32") {
    console.error(
      "nexus-connector is not supported on Windows until a safe transport without shell wrapping is available.",
    );
    return 1;
  }

  const { command, flags } = parseArgs(argv);
  const defaultDataDir = join(homedir(), ".nexus", "connector");
  const dataDir = flags["data-dir"] ?? defaultDataDir;
  const configPath = flags.config ?? join(dataDir, "connector.json");

  try {
    switch (command) {
      case "init": {
        await mkdir(dirname(configPath), { mode: 0o700, recursive: true });
        await initConnector({ configPath });
        logOut(`Initialized connector configuration at ${configPath}`);
        return 0;
      }

      case "status": {
        const status = await connectorStatus(configPath);
        logOut(JSON.stringify(status, null, 2));
        return 0;
      }

      case "add-key": {
        const client = flags.client;
        const keyArg = flags.key;
        if (!client || !keyArg) {
          console.error("Missing required flags: --client <id> --key <path|pem>");
          return 1;
        }
        let pem = keyArg;
        if (existsSync(keyArg)) {
          pem = readFileSync(keyArg, "utf8");
        }
        await registerClientKey({
          configPath,
          clientId: client,
          publicKey: pem,
          ...(flags.label !== undefined ? { label: flags.label } : {}),
        });
        logOut(`Registered key for client '${client}'`);
        return 0;
      }

      case "revoke-key": {
        const client = flags.client;
        const fingerprint = flags.fingerprint;
        if (!client || !fingerprint) {
          console.error("Missing required flags: --client <id> --fingerprint <fingerprint>");
          return 1;
        }
        await revokeClientKey({
          configPath,
          clientId: client,
          fingerprint,
        });
        logOut(`Revoked key with fingerprint ${fingerprint} for client '${client}'`);
        return 0;
      }

      case "set-enabled": {
        const client = flags.client;
        const enabledStr = flags.enabled;
        if (!client || enabledStr === undefined) {
          console.error("Missing required flags: --client <id> --enabled <true|false>");
          return 1;
        }
        const enabled = enabledStr === "true" || enabledStr === "1";
        await setClientEnabled({
          configPath,
          clientId: client,
          enabled,
        });
        logOut(`Client '${client}' enabled state set to ${enabled}`);
        return 0;
      }

      case "start": {
        // Ensure state directory exists with 0700 permissions
        await mkdir(dataDir, { mode: 0o700, recursive: true });

        // Ensure config file exists
        if (!existsSync(configPath)) {
          await initConnector({ configPath });
          logOut(`Created default connector config at ${configPath}`);
        }

        const config = await readConnectorConfig(configPath);

        // Production connector MUST use persistent nonce log, not in-memory store
        const nonceLogPath = join(dataDir, "nonces.jsonl");
        const persistence = new FileNoncePersistence({ path: nonceLogPath });

        const authenticator = new RequestAuthenticator({
          clients: authenticatorClientsFrom(config),
          noncePersistence: persistence,
          acceptanceWindowMs: config.acceptanceWindowMs,
          clockSkewMs: config.clockSkewMs,
        });

        const clock = new SystemClock();
        const registry = createBuiltInRegistry();
        const detector = new ConnectionDetector({
          registry,
          runner: new SafeCommandRunner({
            process: new NodeProcessPort({ platform: "linux" }),
            clock,
          }),
          clock,
          platform: "linux",
        });

        const server = new ConnectorServer({
          detector,
          authenticator,
        });

        let listenTarget: ConnectorListenTarget;
        if (flags.socket) {
          listenTarget = { kind: "unix", path: flags.socket };
        } else if (flags.port) {
          listenTarget = { kind: "loopback", port: parseInt(flags.port, 10) };
        } else if (config.listen.kind === "unix") {
          listenTarget = config.listen;
        } else {
          // Default to secure Unix socket inside data-dir
          listenTarget = { kind: "unix", path: join(dataDir, "connector.sock") };
        }

        const running = await startConnector({
          server,
          listen: listenTarget,
        });

        const bound =
          "path" in running.address ? running.address.path : `127.0.0.1:${running.address.port}`;
        logOut(`nexus-connector listening on ${bound}`);

        const shutdown = async () => {
          logOut("Shutting down nexus-connector...");
          await running.close();
          process.exit(0);
        };

        return new Promise<number>((resolve) => {
          process.once("SIGINT", () => {
            void shutdown().then(() => resolve(0));
          });
          process.once("SIGTERM", () => {
            void shutdown().then(() => resolve(0));
          });
        });
      }

      case "help":
      default:
        printUsage();
        return command === "help" ? 0 : 1;
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
}

// Run CLI directly if main module
if (process.argv[1]?.endsWith("cli.js")) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

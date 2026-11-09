import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import {
  DEFAULT_SPEC,
  HomeAssistantSupervisor,
  supervisorHandler,
  unixDockerEngine,
} from "./supervisor.js";

/**
 * Entry point of the Home Assistant supervisor (see supervisor.ts).
 *
 *   NEXUS_HOME_SUPERVISOR_SOCKET   Unix socket shared with the API
 *                                  (default /run/nexus-home/supervisor.sock)
 *   DOCKER_SOCKET                  default /var/run/docker.sock
 *   HOME_ASSISTANT_IMAGE           pinned image (default in supervisor.ts)
 *   HOME_ASSISTANT_VOLUME          config volume (default nexus_homeassistant-config)
 *   HOME_ASSISTANT_MEMORY_MB       memory cap (default 1024)
 */

/** Trimmed variable, `undefined` when unset or blank. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

const socketPath = process.env.NEXUS_HOME_SUPERVISOR_SOCKET ?? "/run/nexus-home/supervisor.sock";
const memoryMb = Number(process.env.HOME_ASSISTANT_MEMORY_MB ?? "1024");

const supervisor = new HomeAssistantSupervisor(
  unixDockerEngine(process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"),
  {
    ...DEFAULT_SPEC,
    image: env("HOME_ASSISTANT_IMAGE") ?? DEFAULT_SPEC.image,
    volume: env("HOME_ASSISTANT_VOLUME") ?? DEFAULT_SPEC.volume,
    memoryLimitBytes: Number.isFinite(memoryMb)
      ? Math.round(memoryMb) * 1024 * 1024
      : DEFAULT_SPEC.memoryLimitBytes,
  },
);

mkdirSync(dirname(socketPath), { recursive: true });
rmSync(socketPath, { force: true });
const server = createServer(supervisorHandler(supervisor));
server.listen(socketPath, () => {
  // The socket lives in a volume mounted only into the API container, which
  // runs as an unprivileged user.
  chmodSync(socketPath, 0o666);
  process.stdout.write(`home-supervisor listening on ${socketPath}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

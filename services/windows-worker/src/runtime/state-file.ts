import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Public daemon state file.
 */

export interface PublicWorkerState {
  deviceId: string;
  platform: string;
  workerVersion: string;
  startedAt: string;
}

export function defaultStatePath(env: Record<string, string | undefined>): string {
  const root = env.ProgramData ?? env.PROGRAMDATA ?? env.XDG_STATE_HOME ?? ".";
  return join(root, "NEXUS", "worker", "device.json");
}

export async function publishWorkerState(
  path: string,
  state: PublicWorkerState,
): Promise<string | undefined> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

export function publicStateOf(input: {
  deviceId: string;
  platform: string;
  workerVersion: string;
  now: Date;
}): PublicWorkerState {
  return {
    deviceId: input.deviceId,
    platform: input.platform,
    workerVersion: input.workerVersion,
    startedAt: input.now.toISOString(),
  };
}

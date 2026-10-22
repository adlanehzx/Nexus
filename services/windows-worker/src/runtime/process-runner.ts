import { spawn } from "node:child_process";
import { ExecutionCancelledError, ExecutionTimeoutError } from "../errors.js";

/**
 * Process execution port.
 */

export interface ProcessSpawnRequest {
  executable: string;
  args: readonly string[];
  cwd?: string | undefined;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: { stream: "stdout" | "stderr"; text: string }) => void) | undefined;
  maxOutputBytes?: number;
}

export type ProcessStatus = "completed" | "failed" | "timeout" | "cancelled";

export interface ProcessOutcome {
  processId: number | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  status: ProcessStatus;
  truncated: boolean;
}

export interface ProcessInfo {
  processId: number;
  name: string;
  memoryKb?: number;
}

export interface StartedProcess {
  processId: number;
  executable: string;
  startedAt: string;
}

export interface ProcessRunner {
  run(request: ProcessSpawnRequest): Promise<ProcessOutcome>;
  start(request: Omit<ProcessSpawnRequest, "timeoutMs">): Promise<StartedProcess>;
  stop(processId: number, force: boolean): Promise<boolean>;
  list(): Promise<ProcessInfo[]>;
}

const DEFAULT_MAX_OUTPUT = 256 * 1024;

export class NodeProcessRunner implements ProcessRunner {
  run(request: ProcessSpawnRequest): Promise<ProcessOutcome> {
    const startedAt = Date.now();
    const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

    return new Promise<ProcessOutcome>((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;

      const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        request.onOutput?.({ stream, text });

        if (stream === "stdout") {
          if (stdout.length + text.length > limit) truncated = true;
          stdout = (stdout + text).slice(0, limit);
        } else {
          if (stderr.length + text.length > limit) truncated = true;
          stderr = (stderr + text).slice(0, limit);
        }
      };

      child.stdout?.on("data", collect("stdout"));
      child.stderr?.on("data", collect("stderr"));

      const finish = (status: ProcessStatus, exitCode: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          processId: child.pid ?? null,
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          status,
          truncated,
        });
      };

      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        finish("timeout", null, "SIGKILL");
      }, request.timeoutMs);

      const onAbort = () => {
        if (settled) return;
        child.kill("SIGKILL");
        finish("cancelled", null, "SIGKILL");
      };

      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      };

      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });

      child.on("close", (code, signal) => {
        finish(code === 0 ? "completed" : "failed", code, signal);
      });
    });
  }

  start(request: Omit<ProcessSpawnRequest, "timeoutMs">): Promise<StartedProcess> {
    return new Promise<StartedProcess>((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      });

      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve({
          processId: child.pid ?? -1,
          executable: request.executable,
          startedAt: new Date().toISOString(),
        });
      });
    });
  }

  async stop(processId: number, force: boolean): Promise<boolean> {
    const outcome = await this.run({
      executable: "taskkill",
      args: force ? ["/PID", String(processId), "/F"] : ["/PID", String(processId)],
      env: {},
      timeoutMs: 10_000,
    });
    return outcome.status === "completed";
  }

  async list(): Promise<ProcessInfo[]> {
    const outcome = await this.run({
      executable: "tasklist",
      args: ["/FO", "CSV", "/NH"],
      env: {},
      timeoutMs: 15_000,
    });
    return parseTasklistCsv(outcome.stdout);
  }
}

export function parseTasklistCsv(csv: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];

  for (const line of csv.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const fields = line.match(/"([^"]*)"/g)?.map((field) => field.slice(1, -1));
    if (fields === undefined || fields.length < 2) continue;

    const processId = Number.parseInt(fields[1] ?? "", 10);
    if (Number.isNaN(processId)) continue;

    const memory = Number.parseInt((fields[4] ?? "").replace(/[^\d]/g, ""), 10);
    processes.push({
      processId,
      name: fields[0] ?? "unknown",
      ...(Number.isNaN(memory) ? {} : { memoryKb: memory }),
    });
  }

  return processes;
}

export function assertProcessSucceeded(capability: string, outcome: ProcessOutcome): void {
  if (outcome.status === "timeout") {
    throw new ExecutionTimeoutError(capability, outcome.durationMs);
  }
  if (outcome.status === "cancelled") {
    throw new ExecutionCancelledError(capability, "cancelled during execution");
  }
}

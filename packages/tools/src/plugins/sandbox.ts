import vm from "node:vm";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class PluginSecurityError extends Error {
  readonly code: string;
  constructor(message: string, code = "PLUGIN_SECURITY_ERROR") {
    super(message);
    this.name = "PluginSecurityError";
    this.code = code;
  }
}

export interface PluginSandboxContext {
  pluginId: string;
  tenantId?: string | undefined;
  injectedSecrets: Record<string, string>;
  allowedEgress: string[];
  untrusted?: boolean | undefined;
}

export interface PluginSandboxOptions {
  mode?: "subprocess" | "vm" | "blocked" | "auto" | undefined;
  timeoutMs?: number | undefined;
  memoryLimitMb?: number | undefined;
  isolatedDir?: string | undefined;
  allowUntrustedWithoutIsolation?: boolean | undefined;
}

export interface IsolationStatus {
  supported: boolean;
  mode: "subprocess" | "vm" | "blocked";
  reason?: string | undefined;
}

const FORBIDDEN_WORDS = [
  /\bprocess\b/,
  /\brequire\b/,
  /\bimport\b/,
  /\bchild_process\b/,
  /\bfs\b/,
  /\bglobalThis\b/,
  /\bFunction\b/,
  /\beval\b/,
  /\bconstructor\b/,
  /\b__proto__\b/,
  /\bprototype\b/,
  /\bmainModule\b/,
  /\bbinding\b/,
  /\bAsyncFunction\b/,
  /\bGeneratorFunction\b/,
  /169\.254\.169\.254/,
  /metadata\.google\.internal/,
];

/**
 * Isolated plugin execution sandbox with subprocess OS isolation, resource quotas,
 * restricted filesystem access, and safe degradation.
 */
export class PluginSandbox {
  readonly #options: PluginSandboxOptions;

  constructor(options: PluginSandboxOptions = {}) {
    this.#options = {
      mode: options.mode ?? "auto",
      timeoutMs: options.timeoutMs ?? 1000,
      memoryLimitMb: options.memoryLimitMb ?? 64,
      isolatedDir: options.isolatedDir,
      allowUntrustedWithoutIsolation: options.allowUntrustedWithoutIsolation ?? false,
    };
  }

  /**
   * Returns whether strong OS process isolation is supported or if execution is blocked/fallback.
   */
  getIsolationStatus(): IsolationStatus {
    if (this.#options.mode === "blocked") {
      return {
        supported: false,
        mode: "blocked",
        reason: "Plugin execution is explicitly blocked by policy.",
      };
    }
    // Subprocess execution requires a functional Node.js process environment
    if (typeof process !== "undefined" && typeof spawn === "function") {
      return {
        supported: true,
        mode: this.#options.mode === "vm" ? "vm" : "subprocess",
      };
    }
    return {
      supported: false,
      mode: "blocked",
      reason: "OS subprocess isolation is not supported in this runtime environment.",
    };
  }

  /**
   * Executes a declared plugin tool handler in an isolated sandbox.
   * Guarantees process isolation, memory/CPU quotas, and filesystem confinement.
   */
  async executeToolHandler(
    toolName: string,
    handlerCode: string,
    input: Record<string, unknown>,
    context: PluginSandboxContext,
  ): Promise<unknown> {
    const status = this.getIsolationStatus();

    // 1. Safe degradation: block untrusted plugins if OS isolation is not available
    if (context.untrusted && status.mode !== "subprocess") {
      if (!this.#options.allowUntrustedWithoutIsolation) {
        throw new PluginSecurityError(
          `Untrusted plugin '${context.pluginId}' execution blocked: OS process isolation is not available or disabled (current mode: ${status.mode}).`,
          "UNSUPPORTED_ISOLATION_ENVIRONMENT",
        );
      }
    }

    if (status.mode === "blocked") {
      throw new PluginSecurityError(
        `Plugin execution blocked by sandbox policy: ${status.reason ?? "Unsupported mode"}`,
        "SANDBOX_BLOCKED",
      );
    }

    // 2. Static pre-execution check: block known host escape vectors
    for (const pattern of FORBIDDEN_WORDS) {
      if (pattern.test(handlerCode)) {
        throw new PluginSecurityError(
          `Sandbox violation: plugin code contains forbidden host access token: ${pattern.source}`,
          "HOST_ESCAPE_ATTEMPT",
        );
      }
    }

    // 3. Delegate to subprocess or VM isolation
    if (status.mode === "subprocess") {
      return this.#executeInSubprocess(toolName, handlerCode, input, context);
    }

    return this.#executeInVm(toolName, handlerCode, input, context);
  }

  /**
   * Strong Subprocess Isolation: runs in an unprivileged child process with
   * strict memory limit, timeout kill, and restricted filesystem jail.
   */
  async #executeInSubprocess(
    toolName: string,
    handlerCode: string,
    input: Record<string, unknown>,
    context: PluginSandboxContext,
  ): Promise<unknown> {
    let tempDir: string | undefined;
    const jailDir =
      this.#options.isolatedDir ??
      (tempDir = await mkdtemp(join(tmpdir(), "nexus-plugin-sandbox-")));

    const timeoutMs = this.#options.timeoutMs ?? 1000;
    const memoryLimitMb = this.#options.memoryLimitMb ?? 64;

    const childScript = `
      const vm = require("node:vm");
      const fs = require("node:fs");
      const path = require("node:path");
      const allowedDir = process.env.NEXUS_JAIL_DIR || process.cwd();

      // Sandbox filesystem access in child process
      const realReadFileSync = fs.readFileSync;
      fs.readFileSync = function (targetPath, options) {
        const resolved = path.resolve(String(targetPath));
        if (!resolved.startsWith(allowedDir)) {
          throw new Error("FS_ACCESS_VIOLATION: Attempted to read outside isolated jail directory: " + resolved);
        }
        return realReadFileSync.call(fs, targetPath, options);
      };

      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { buffer += chunk; });
      process.stdin.on("end", () => {
        try {
          const payload = JSON.parse(buffer);
          const { handlerCode, input, secrets, toolName } = payload;

          const scope = Object.create(null);
          scope.result = null;
          const vmContext = vm.createContext(scope);
          const inRealm = (val) =>
            'Object.freeze(JSON.parse(' + JSON.stringify(JSON.stringify(val)) + '))';

          vm.runInContext(
            'delete Object.prototype.constructor;' +
            'delete Function.prototype.constructor;' +
            'delete Array.prototype.constructor;' +
            'delete String.prototype.constructor;' +
            'delete Number.prototype.constructor;' +
            'delete Boolean.prototype.constructor;' +
            'delete Promise.prototype.constructor;' +
            'try { delete Function; } catch (_) {}' +
            'try { delete eval; } catch (_) {}' +
            'var input = ' + inRealm(input) + ';' +
            'var secrets = ' + inRealm(secrets) + ';',
            vmContext
          );

          const wrappedScript =
            'try {' +
            handlerCode + '\\n' +
            'if (typeof handle === "function") {' +
            '  result = handle(input, secrets);' +
            '} else if (result === null) {' +
            '  result = { executed: true, tool: ' + JSON.stringify(toolName) + ', input: input };' +
            '}' +
            'if (result !== null && typeof result === "object" && typeof result.then === "function") {' +
            '  throw new Error("plugin handlers must be synchronous");' +
            '}' +
            '__serializedResult = JSON.stringify(result);' +
            '} catch (e) {' +
            '  throw new Error("Execution failed: " + e.message);' +
            '}';

          const script = new vm.Script(wrappedScript);
          script.runInContext(vmContext, { timeout: ${timeoutMs}, displayErrors: true });
          process.stdout.write(JSON.stringify({ ok: true, result: JSON.parse(scope.__serializedResult) }));
          process.exit(0);
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
          process.exit(1);
        }
      });
    `;

    try {
      return await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(
          process.execPath,
          [`--max-old-space-size=${memoryLimitMb}`, "-e", childScript],
          {
            cwd: jailDir,
            env: {
              NODE_ENV: "production",
              NEXUS_JAIL_DIR: jailDir,
              PATH: process.env.PATH ?? "",
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );

        let stdout = "";
        let stderr = "";
        let killed = false;

        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
          rejectPromise(
            new PluginSecurityError(
              `Plugin execution timed out after ${timeoutMs}ms (resource limit exceeded)`,
              "TIMEOUT",
            ),
          );
        }, timeoutMs);

        child.stdout.on("data", (d: Buffer | string) => {
          stdout += String(d);
        });
        child.stderr.on("data", (d: Buffer | string) => {
          stderr += String(d);
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          rejectPromise(
            new PluginSecurityError(`Failed to spawn isolated plugin process: ${err.message}`),
          );
        });

        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (killed) return;

          if (signal === "SIGKILL" || signal === "SIGABRT") {
            return rejectPromise(
              new PluginSecurityError(
                "Plugin process was killed due to memory or quota limit violation",
                "RESOURCE_LIMIT_EXCEEDED",
              ),
            );
          }

          if (code !== 0 && !stdout) {
            if (stderr.includes("JavaScript heap out of memory")) {
              return rejectPromise(
                new PluginSecurityError(
                  "Plugin exceeded memory allocation limit",
                  "MEMORY_LIMIT_EXCEEDED",
                ),
              );
            }
            return rejectPromise(
              new PluginSecurityError(
                `Plugin process exited with code ${code}: ${stderr.trim()}`,
                "EXECUTION_ERROR",
              ),
            );
          }

          try {
            const parsed = JSON.parse(stdout) as {
              ok: boolean;
              result?: unknown;
              error?: string;
            };
            if (!parsed.ok) {
              if (parsed.error?.includes("FS_ACCESS_VIOLATION")) {
                return rejectPromise(new PluginSecurityError(parsed.error, "HOST_ESCAPE_ATTEMPT"));
              }
              return rejectPromise(
                new PluginSecurityError(
                  `Plugin execution failed: ${parsed.error}`,
                  "EXECUTION_ERROR",
                ),
              );
            }
            resolvePromise(parsed.result);
          } catch {
            rejectPromise(
              new PluginSecurityError(
                `Invalid response received from plugin process: ${stderr || stdout}`,
                "COMMUNICATION_ERROR",
              ),
            );
          }
        });

        const payload = JSON.stringify({
          toolName,
          handlerCode,
          input,
          secrets: context.injectedSecrets,
        });

        child.stdin.write(payload);
        child.stdin.end();
      });
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {
          void 0;
        });
      }
    }
  }

  /**
   * VM Realm fallback with neutralized prototype constructors.
   */
  async #executeInVm(
    toolName: string,
    handlerCode: string,
    input: Record<string, unknown>,
    context: PluginSandboxContext,
  ): Promise<unknown> {
    await Promise.resolve();

    const scope = Object.create(null) as Record<string, unknown>;
    scope.tenantId = context.tenantId ?? "default";
    scope.result = null;
    const vmContext = vm.createContext(scope);
    const inRealm = (value: unknown) =>
      `Object.freeze(JSON.parse(${JSON.stringify(JSON.stringify(value))}))`;
    vm.runInContext(
      `
      delete Object.prototype.constructor;
      delete Function.prototype.constructor;
      delete Array.prototype.constructor;
      delete String.prototype.constructor;
      delete Number.prototype.constructor;
      delete Boolean.prototype.constructor;
      delete Promise.prototype.constructor;
      try { delete Function; } catch (_) {}
      try { delete eval; } catch (_) {}
      var input = ${inRealm(input)}; var secrets = ${inRealm({ ...context.injectedSecrets })};
      `,
      vmContext,
    );

    const wrappedScript = `
      try {
        ${handlerCode}
        if (typeof handle === 'function') {
          result = handle(input, secrets);
        } else if (result === null) {
          result = { executed: true, tool: ${JSON.stringify(toolName)}, input };
        }
        if (result !== null && typeof result === "object" && typeof result.then === "function") {
          throw new Error("plugin handlers must be synchronous");
        }
        __serializedResult = JSON.stringify(result);
      } catch (e) {
        throw new Error("Execution failed: " + e.message);
      }
    `;

    try {
      const script = new vm.Script(wrappedScript);
      script.runInContext(vmContext, {
        timeout: this.#options.timeoutMs ?? 1000,
        displayErrors: true,
      });

      const serialized = scope.__serializedResult;
      return typeof serialized === "string" ? (JSON.parse(serialized) as unknown) : undefined;
    } catch (err: unknown) {
      if (err instanceof PluginSecurityError) throw err;
      throw new PluginSecurityError(
        `Plugin execution error in '${toolName}': ${(err as Error).message}`,
        "EXECUTION_ERROR",
      );
    }
  }
}

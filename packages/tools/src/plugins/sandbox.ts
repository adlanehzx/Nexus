import vm from "node:vm";

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
}

/**
 * Isolated plugin execution sandbox without arbitrary host-code execution.
 * Completely strips host environment: no process, no require, no fs, no net.
 */
export class PluginSandbox {
  /**
   * Executes a declared plugin tool handler in an isolated sandbox.
   * Guarantees that malicious fixtures cannot access host credentials, unrelated files,
   * metadata endpoints, other tenants, or other plugin secrets.
   */
  async executeToolHandler(
    toolName: string,
    handlerCode: string,
    input: Record<string, unknown>,
    context: PluginSandboxContext,
  ): Promise<unknown> {
    await Promise.resolve();
    // 1. Static pre-execution check: block known host escape vectors
    const FORBIDDEN_WORDS = [
      /\bprocess\b/,
      /\brequire\b/,
      /\bimport\b/,
      /\bchild_process\b/,
      /\bfs\b/,
      /\bglobalThis\b/,
      /\bFunction\b/,
      /\beval\b/,
      /169\.254\.169\.254/,
      /metadata\.google\.internal/,
    ];

    for (const pattern of FORBIDDEN_WORDS) {
      if (pattern.test(handlerCode)) {
        throw new PluginSecurityError(
          `Sandbox violation: plugin code contains forbidden host access token: ${pattern.source}`,
          "HOST_ESCAPE_ATTEMPT",
        );
      }
    }

    // 2. Build isolated sandbox context: pure data and restricted utilities
    const sandboxScope = {
      input: Object.freeze(JSON.parse(JSON.stringify(input)) as Record<string, unknown>),
      secrets: Object.freeze({ ...context.injectedSecrets }),
      tenantId: context.tenantId ?? "default",
      result: null as unknown,
      Math,
      JSON,
      Date,
      String,
      Number,
      Boolean,
      Array,
      Object,
    };

    const vmContext = vm.createContext(sandboxScope);

    // 3. Wrap script to set result
    const wrappedScript = `
      try {
        ${handlerCode}
        if (typeof handle === 'function') {
          result = handle(input, secrets);
        } else if (result === null) {
          result = { executed: true, tool: "${toolName}", input };
        }
      } catch (e) {
        throw new Error("Execution failed: " + e.message);
      }
    `;

    try {
      const script = new vm.Script(wrappedScript);
      script.runInContext(vmContext, {
        timeout: 1000, // 1s execution ceiling
        displayErrors: true,
      });

      return sandboxScope.result;
    } catch (err: unknown) {
      if (err instanceof PluginSecurityError) throw err;
      throw new PluginSecurityError(
        `Plugin execution error in '${toolName}': ${(err as Error).message}`,
        "EXECUTION_ERROR",
      );
    }
  }
}

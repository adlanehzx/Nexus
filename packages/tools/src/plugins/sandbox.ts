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

    for (const pattern of FORBIDDEN_WORDS) {
      if (pattern.test(handlerCode)) {
        throw new PluginSecurityError(
          `Sandbox violation: plugin code contains forbidden host access token: ${pattern.source}`,
          "HOST_ESCAPE_ATTEMPT",
        );
      }
    }

    // 2. Build the sandbox from its own realm. Nothing from the host is passed in, not even
    // Math or the input object: from any host object, `.constructor.constructor` reaches the
    // host's Function and therefore `process`. The word filter above cannot prevent that,
    // since a plugin can spell the property at run time.
    const scope = Object.create(null) as Record<string, unknown>;
    scope.tenantId = context.tenantId ?? "default";
    scope.result = null;
    const vmContext = vm.createContext(scope);
    const inRealm = (value: unknown) =>
      `Object.freeze(JSON.parse(${JSON.stringify(JSON.stringify(value))}))`;
    vm.runInContext(
      `var input = ${inRealm(input)}; var secrets = ${inRealm({ ...context.injectedSecrets })};`,
      vmContext,
    );

    // 3. Wrap script to set result. The result leaves as text, so that the host only ever
    // holds its own objects and never runs a getter a plugin defined. A promise is refused:
    // awaiting it from the host would hand a plugin-defined `then` a host function.
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
        timeout: 1000, // 1s execution ceiling
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

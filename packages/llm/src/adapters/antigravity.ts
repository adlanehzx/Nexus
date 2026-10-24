import { CliProvider } from "./cli-provider.js";

/** Direct native Antigravity CLI harness. It does not use the community ACP adapter. */
export class AntigravityCliProvider extends CliProvider {
  constructor(options: { command?: string; model?: string; timeoutMs?: number } = {}) {
    super({
      command: options.command ?? "agy",
      argsPrefix: ["--output-format", "text"],
      id: "antigravity-native",
      model: options.model ?? "antigravity-default",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }
}

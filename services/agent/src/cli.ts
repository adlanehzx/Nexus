#!/usr/bin/env node
import { runAcp } from "./runner.js";

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing_${name}`);
  return value;
}

async function stdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
}

try {
  const result = await runAcp({
    profile: argument("profile"),
    cwd: argument("cwd"),
    registryPath: argument("registry"),
    prompt: await stdin(),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "agent_transport"}\n`);
  process.exitCode = 1;
}

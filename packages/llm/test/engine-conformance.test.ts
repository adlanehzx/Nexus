import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { LLMProvider } from "../src/provider.js";
import { LLMProviderError } from "../src/provider.js";
import {
  AntigravityCliProvider,
  DeepSeekProvider,
  FreeLlmProvider,
  LlamaCppProvider,
  OllamaProvider,
  VllmProvider,
} from "../src/index.js";

const structuredSchema = z.object({ result: z.literal("ok") });
const request = {
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
};

describe("engine conformance", () => {
  let server: Server;
  let baseURL: string;
  let temporaryDirectory: string;
  let providers: LLMProvider[];

  beforeAll(async () => {
    server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: { role: string; content: string }[];
        };
        const structured = body.messages?.some((message) =>
          /schema|Return only JSON/.test(message.content),
        );
        if (body.messages?.some((message) => message.content === "fail")) {
          response.statusCode = 503;
          response.end('{"error":"redacted fixture"}');
          return;
        }
        response.setHeader("content-type", "application/json");
        if (incoming.url === "/api/chat") {
          response.end(
            JSON.stringify({
              model: "fixture-local",
              message: { content: structured ? '{"result":"ok"}' : "hello" },
              prompt_eval_count: 7,
              eval_count: 2,
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            model: "fixture-openai",
            choices: [
              {
                message: { content: structured ? '{"result":"ok"}' : "hello" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server failed");
    baseURL = `http://127.0.0.1:${address.port}`;

    temporaryDirectory = await mkdtemp(join(tmpdir(), "nexus-antigravity-"));
    const fakeAgy = join(temporaryDirectory, "agy-fixture.mjs");
    await writeFile(
      fakeAgy,
      `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? "";
if (prompt.endsWith("user: fail")) process.exit(2);
process.stdout.write(prompt.includes("strict JSON object") ? '{"result":"ok"}' : "hello");
`,
      "utf8",
    );
    await chmod(fakeAgy, 0o700);

    providers = [
      new AntigravityCliProvider({ command: fakeAgy, model: "fixture-antigravity" }),
      new DeepSeekProvider({ apiKey: "fixture-not-a-secret", baseURL, model: "fixture" }),
      new FreeLlmProvider({ baseURL, model: "fixture" }),
      new OllamaProvider({ baseURL, model: "fixture" }),
      new LlamaCppProvider({ baseURL, model: "fixture" }),
      new VllmProvider({ baseURL, model: "fixture" }),
    ];
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("passes generate, stream, structured output, and token counting for every backend", async () => {
    for (const provider of providers) {
      const generated = await provider.generate(request);
      expect(generated.content).toEqual([{ type: "text", text: "hello" }]);
      expect(generated.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(generated.usage.outputTokens).toBeGreaterThanOrEqual(0);

      const chunks = [];
      for await (const chunk of provider.stream(request)) chunks.push(chunk);
      expect(chunks.at(-1)?.type).toBe("done");

      await expect(provider.structuredOutput(request, structuredSchema)).resolves.toEqual({
        result: "ok",
      });
      await expect(provider.countTokens(request)).resolves.toBeGreaterThan(0);
    }
  });

  it("keeps the native Antigravity harness distinct from ACP", () => {
    const provider = providers[0] as AntigravityCliProvider;
    expect(provider.id).toBe("antigravity-native");
    expect(provider.command).toContain("agy-fixture");
  });

  it("normalizes backend failures without returning provider output", async () => {
    for (const provider of providers) {
      const failed = provider.generate({
        messages: [{ role: "user", content: [{ type: "text", text: "fail" }] }],
      });
      await expect(failed).rejects.toBeInstanceOf(LLMProviderError);
      await expect(failed).rejects.not.toThrow("redacted fixture");
    }
  });
});

import { describe, test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { ClaudeCliProvider, GeminiCliProvider } from "../src/adapters/cli-provider.js";
import { LocalLLMProvider } from "../src/adapters/local-provider.js";
import { FallbackProvider } from "../src/adapters/fallback-provider.js";
import { LLMProviderError, type LLMProvider } from "../src/provider.js";

// Mock child_process for CLI providers
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
  };
});
import { spawn, type ChildProcess } from "node:child_process";

const schema = z.object({
  result: z.string(),
});

type MockProcess = ChildProcess & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

/**
 * Un faux processus enfant.
 *
 * Les flux sont de simples `EventEmitter` : les adaptateurs n'écoutent que
 * `data` et `close`, et rien ici n'a besoin d'un vrai `Readable`. La conversion
 * a lieu **une seule fois, sur l'objet fini** — l'affecter propriété par
 * propriété obligeait chaque flux à satisfaire `Readable` en entier, ce qui
 * n'apportait aucune garantie et refusait de compiler.
 */
function createMockProcess(): MockProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  }) as unknown as MockProcess;
}

describe("LLM Providers Phase 2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CliProvider (Claude / Gemini)", () => {
    test("Doit lancer la commande correctement et retourner le texte", async () => {
      const mockProc = createMockProcess();

      vi.mocked(spawn).mockReturnValue(mockProc);

      const provider = new ClaudeCliProvider();
      const promise = provider.generate({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });

      mockProc.stdout.emit("data", Buffer.from("World!"));
      mockProc.emit("close", 0);

      const res = await promise;
      const textContent = res.content[0] as Extract<(typeof res.content)[0], { type: "text" }>;
      expect(textContent.type).toBe("text");
      expect(textContent.text).toBe("World!");
      const isWin = process.platform === "win32";
      expect(spawn).toHaveBeenCalledWith(
        isWin ? "npx.cmd" : "npx",
        ["--yes", "@anthropic-ai/claude-code", "-p", "user: Hello"],
        expect.any(Object),
      );
    });

    test("Doit throw une erreur retryable si exit code non nul", async () => {
      const mockProc = createMockProcess();

      vi.mocked(spawn).mockReturnValue(mockProc);

      const provider = new GeminiCliProvider();
      const promise = provider.generate({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });

      mockProc.stderr.emit("data", Buffer.from("Error internal"));
      mockProc.emit("close", 1);

      await expect(promise).rejects.toThrowError(LLMProviderError);
      await expect(promise).rejects.toMatchObject({ retryable: true });
    });

    test("Doit retourner un JSON valide via structuredOutput", async () => {
      const mockProc = createMockProcess();

      vi.mocked(spawn).mockReturnValue(mockProc);

      const provider = new ClaudeCliProvider();
      const promise = provider.structuredOutput(
        { messages: [{ role: "user", content: [{ type: "text", text: "Format" }] }] },
        schema,
      );

      // Simuler une réponse JSON encapsulée dans du texte
      mockProc.stdout.emit("data", Buffer.from('Voici le json:\n{ "result": "ok" }\nAu revoir.'));
      mockProc.emit("close", 0);

      const res = await promise;
      expect(res.result).toBe("ok");
    });
  });

  describe("LocalLLMProvider", () => {
    test("Vérifie les propriétés", () => {
      const provider = new LocalLLMProvider({ baseURL: "http://localhost:9999" });
      expect(provider.baseURL).toBe("http://localhost:9999");
      expect(provider.id).toBe("local-llm");
    });
  });

  describe("FallbackProvider", () => {
    test("Doit passer au suivant si le premier échoue (retryable)", async () => {
      const failingProvider: LLMProvider = {
        id: "fail",
        model: "fail",
        capabilities: { tools: false, vision: false, structuredOutput: false, maxContextTokens: 0 },
        generate: vi
          .fn()
          .mockRejectedValue(new LLMProviderError("fail", { message: "down", retryable: true })),
        stream: vi.fn(),
        structuredOutput: vi.fn(),
        countTokens: vi.fn(),
      };

      const successProvider: LLMProvider = {
        id: "success",
        model: "success",
        capabilities: { tools: false, vision: false, structuredOutput: false, maxContextTokens: 0 },
        generate: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "Success!" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "success",
        }),
        stream: vi.fn(),
        structuredOutput: vi.fn(),
        countTokens: vi.fn(),
      };

      const fallback = new FallbackProvider([failingProvider, successProvider]);
      const res = await fallback.generate({ messages: [] });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(vi.mocked(failingProvider.generate)).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(vi.mocked(successProvider.generate)).toHaveBeenCalled();
      const textContent = res.content[0] as Extract<(typeof res.content)[0], { type: "text" }>;
      expect(textContent.text).toBe("Success!");
    });

    test("Doit crasher directement si l'erreur n'est pas retryable", async () => {
      const fatalProvider: LLMProvider = {
        id: "fatal",
        model: "fatal",
        capabilities: { tools: false, vision: false, structuredOutput: false, maxContextTokens: 0 },
        generate: vi
          .fn()
          .mockRejectedValue(
            new LLMProviderError("fatal", { message: "unauth", retryable: false }),
          ),
        stream: vi.fn(),
        structuredOutput: vi.fn(),
        countTokens: vi.fn(),
      };
      const fallback = new FallbackProvider([fatalProvider]);

      await expect(fallback.generate({ messages: [] })).rejects.toThrowError(LLMProviderError);
    });
  });
});

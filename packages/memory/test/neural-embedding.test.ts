import { describe, expect, it, vi } from "vitest";
import { TransformersEmbeddingProvider } from "../src/embedding.js";

describe("TransformersEmbeddingProvider", () => {
  it("loads model once and normalizes batches", async () => {
    const first = Array.from<number>({ length: 32 }).fill(0);
    first[0] = 1;
    const second = Array.from<number>({ length: 32 }).fill(0);
    second[1] = 1;
    const extractor = vi.fn().mockResolvedValue({
      tolist: () => [first, second],
    });
    const load = vi.fn().mockResolvedValue(extractor);
    const provider = new TransformersEmbeddingProvider({
      model: "local-test-model",
      dimensions: 32,
      load,
    });

    await expect(provider.embed(["hello", "hi"])).resolves.toEqual([first, second]);
    await provider.embed(["once", "again"]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledWith(["hello", "hi"], {
      pooling: "mean",
      normalize: true,
    });
  });

  it("rejects incorrectly sized vectors", async () => {
    const provider = new TransformersEmbeddingProvider({
      dimensions: 32,
      load: () => Promise.resolve(() => Promise.resolve({ tolist: () => [[1, 2]] })),
    });

    await expect(provider.embed(["text"])).rejects.toThrow(/32 finite numbers/);
  });
});

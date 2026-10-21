import { describe, expect, it, vi } from "vitest";
import { TransformersEmbeddingProvider } from "../src/embedding.js";

describe("TransformersEmbeddingProvider", () => {
  it("charge le modèle une seule fois et normalise les lots", async () => {
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

    await expect(provider.embed(["bonjour", "salut"])).resolves.toEqual([first, second]);
    await provider.embed(["encore", "une fois"]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledWith(["bonjour", "salut"], {
      pooling: "mean",
      normalize: true,
    });
  });

  it("refuse silencieusement aucun vecteur mal dimensionné", async () => {
    const provider = new TransformersEmbeddingProvider({
      dimensions: 32,
      load: () => Promise.resolve(() => Promise.resolve({ tolist: () => [[1, 2]] })),
    });

    await expect(provider.embed(["texte"])).rejects.toThrow(/32 nombres finis/);
  });
});

import { describe, expect, it } from "vitest";
import { LocalHashEmbeddingProvider, TransformersEmbeddingProvider } from "../src/embedding.js";

/**
 * Proves semantic recall is real.
 *
 * N-01: `onnxruntime-node` ships glibc prebuilts only, so on a musl image the
 * neural backend failed to load, writing a memory answered 500, and semantic
 * search never worked — while the hash backend would have hidden the loss
 * behind plausible-looking results. These tests pin the difference that
 * matters: the model must rank meaning above wording, which feature hashing
 * cannot do.
 *
 * Opt-in via `pnpm --filter @nexus/memory test:embeddings`.
 */

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

const PARAPHRASE = "The cat is sleeping on the sofa";
const SAME_MEANING = "A feline is napping on the couch";
const UNRELATED = "Quarterly revenue exceeded the forecast";

describe("semantic recall with the real model", () => {
  it("loads the ONNX runtime at all", async () => {
    // The failure this guards against is a load error, not a bad result: on a
    // musl base this rejects with "Error loading shared library ld-linux".
    const provider = new TransformersEmbeddingProvider();
    const [vector] = await provider.embed(["hello"]);

    expect(vector).toHaveLength(provider.dimensions);
    expect(vector!.every((value) => Number.isFinite(value))).toBe(true);
  });

  it("ranks meaning above wording, which the hash backend cannot", async () => {
    const provider = new TransformersEmbeddingProvider();
    const [base, paraphrase, unrelated] = await provider.embed([
      PARAPHRASE,
      SAME_MEANING,
      UNRELATED,
    ]);

    const near = cosine(base!, paraphrase!);
    const far = cosine(base!, unrelated!);

    // A paraphrase sharing almost no vocabulary must still land closer than an
    // unrelated sentence. This is the property semantic search is bought for.
    expect(near).toBeGreaterThan(far);
    expect(near - far).toBeGreaterThan(0.15);
  });

  it("shows the hash backend failing that same property, so the difference is documented", async () => {
    const hashed = new LocalHashEmbeddingProvider();
    const [base, paraphrase, unrelated] = await hashed.embed([
      PARAPHRASE,
      SAME_MEANING,
      UNRELATED,
    ]);

    const near = cosine(base!, paraphrase!);
    const far = cosine(base!, unrelated!);

    // Not an assertion about quality being acceptable: a record that choosing
    // `hash` loses paraphrase recall, so the choice is never made by accident.
    expect(near - far).toBeLessThan(0.15);
  });

  it("keeps embeddings deterministic across calls", async () => {
    const provider = new TransformersEmbeddingProvider();
    const [first] = await provider.embed([PARAPHRASE]);
    const [second] = await provider.embed([PARAPHRASE]);

    expect(cosine(first!, second!)).toBeGreaterThan(0.999);
  });
});

import { z } from "zod";

/**
 * Converts a Zod schema to JSON Schema for tool descriptions.
 *
 * Zod 4 provides native `toJSONSchema` — no additional dependency required.
 * We force `io: "input"`: we describe the input shape expected by the tool to
 * the model, not the post-transformation output shape.
 *
 * `$schema` is stripped: providers do not expect it within tool schemas, and
 * its presence breaks certain strict validators.
 */
export function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  const { $schema: _schema, ...rest } = json;
  return rest;
}

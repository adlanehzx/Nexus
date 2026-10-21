import { Validator } from "@cfworker/json-schema";
import { z } from "zod";

/**
 * MCP tool argument validation.
 *
 * MCP servers declare inputs via JSON Schema rather than Zod. We validate
 * inputs against the original JSON Schema using `@cfworker/json-schema` and wrap
 * the result in a Zod type so `ToolDefinition` remains uniform.
 */

const DEFAULT_DRAFT = "2020-12" as const;

export interface JsonSchemaValidationIssue {
  path: string;
  message: string;
}

function formatIssues(errors: readonly { instanceLocation: string; error: string }[]): string {
  return errors
    .slice(0, 5)
    .map(
      (issue) =>
        `${issue.instanceLocation === "#" ? "(root)" : issue.instanceLocation} — ${issue.error}`,
    )
    .join(" ; ");
}

/**
 * Builds a `z.ZodType` validating against a JSON Schema.
 * The validator is compiled once upon tool discovery.
 */
export function zodFromJsonSchema(
  schema: Record<string, unknown>,
  draft: "4" | "7" | "2019-09" | "2020-12" = DEFAULT_DRAFT,
): z.ZodType<unknown> {
  const validator = new Validator(schema, draft);

  return z.unknown().superRefine((value, ctx) => {
    const result = validator.validate(value);
    if (result.valid) return;
    ctx.addIssue({ code: "custom", message: formatIssues(result.errors) });
  });
}

/**
 * Normalizes tool schema before passing to model.
 * Adds empty `properties` if missing on object schemas, and strips `$schema`.
 */
export function normalizeToolSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;

  if (rest.type === "object" && rest.properties === undefined) {
    return { ...rest, properties: {} };
  }
  return rest;
}

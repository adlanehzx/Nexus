import { z } from "zod";

export const boundingBoxSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type BoundingBox = z.infer<typeof boundingBoxSchema>;

export const uiElementTypeSchema = z.enum([
  "button",
  "input",
  "link",
  "text",
  "checkbox",
  "select",
  "menu",
  "dialog",
  "icon",
  "unknown",
]);
export type UiElementType = z.infer<typeof uiElementTypeSchema>;

export const uiElementSchema = z.object({
  id: z.string().min(1),
  type: uiElementTypeSchema,
  label: z.string().optional(),
  bbox: boundingBoxSchema,
  confidence: z.number().min(0).max(1),
  interactable: z.boolean(),
  attributes: z.record(z.string(), z.string()).optional(),
});
export type UiElement = z.infer<typeof uiElementSchema>;

export const visualParseResultSchema = z.object({
  engine: z.string().min(1),
  timestamp: z.string(),
  elements: z.array(uiElementSchema),
  width: z.number().positive(),
  height: z.number().positive(),
  confidence: z.number().min(0).max(1),
  rawText: z.string().optional(),
});
export type VisualParseResult = z.infer<typeof visualParseResultSchema>;

export interface VisualParseOptions {
  minConfidence?: number | undefined;
  elementFilter?: UiElementType[] | undefined;
  targetScreenId?: string | undefined;
  maxElements?: number | undefined;
}

/**
 * Model-independent visual parser port.
 * Allows interchangeable vision models (OmniParser, Florence-2, local heuristics, OCR).
 */
export interface VisualParserPort {
  readonly name: string;
  readonly available: boolean;
  parseScreen(
    image: Buffer | string,
    dimensions: { width: number; height: number },
    options?: VisualParseOptions,
  ): Promise<VisualParseResult>;
}

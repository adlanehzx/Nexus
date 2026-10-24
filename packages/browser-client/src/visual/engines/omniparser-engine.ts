import type {
  VisualParserPort,
  VisualParseResult,
  VisualParseOptions,
  UiElement,
} from "../parser-port.js";

export interface OmniParserEngineOptions {
  serviceEndpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Optional OmniParser adapter behind the typed VisualParserPort.
 * Fails closed and reports availability status truthfully.
 */
export class OmniParserEngine implements VisualParserPort {
  readonly name = "omniparser";
  private endpoint?: string | undefined;
  private timeoutMs: number;

  constructor(options?: OmniParserEngineOptions) {
    this.endpoint = options?.serviceEndpoint;
    this.timeoutMs = options?.timeoutMs ?? 10_000;
  }

  get available(): boolean {
    return Boolean(this.endpoint?.startsWith("http"));
  }

  async parseScreen(
    image: Buffer | string,
    dimensions: { width: number; height: number },
    options?: VisualParseOptions,
  ): Promise<VisualParseResult> {
    if (!this.available) {
      throw new Error(
        "OmniParser engine is not configured or unavailable. Set serviceEndpoint or use HeuristicVisualParserEngine fallback.",
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const base64Image = typeof image === "string" ? image : image.toString("base64");

      const response = await fetch(`${this.endpoint}/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: base64Image,
          width: dimensions.width,
          height: dimensions.height,
          minConfidence: options?.minConfidence ?? 0.4,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `OmniParser service returned status ${response.status}: ${response.statusText}`,
        );
      }

      const data = (await response.json()) as {
        elements: {
          id: string;
          type: string;
          label?: string;
          bbox: [number, number, number, number];
          confidence: number;
          interactable: boolean;
        }[];
        overallConfidence?: number;
      };

      const elements: UiElement[] = (data.elements || []).map((el) => ({
        id: el.id,
        type: (el.type as UiElement["type"]) || "unknown",
        label: el.label,
        bbox: {
          x: el.bbox[0],
          y: el.bbox[1],
          width: el.bbox[2],
          height: el.bbox[3],
        },
        confidence: el.confidence,
        interactable: el.interactable,
      }));

      return {
        engine: this.name,
        timestamp: new Date().toISOString(),
        elements,
        width: dimensions.width,
        height: dimensions.height,
        confidence: data.overallConfidence ?? 0.92,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

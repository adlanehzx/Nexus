import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { AndroidUiController, UiSelector } from "../ports.js";
import type { UiPolicy } from "../policy/ui-policy.js";
import { AccessibilityDisabledError, UiNodeNotFoundError } from "../errors.js";

/**
 * `android.ui.click`, `android.ui.input`, `android.ui.scroll`.
 */

const selectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("viewId"), value: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("text"), value: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("contentDescription"), value: z.string().min(1).max(256) }),
  z.object({
    kind: z.literal("coordinates"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
]);

export const clickInputSchema = z.object({ selector: selectorSchema });

export const inputTextSchema = z.object({
  selector: selectorSchema,
  /**
   * Text to input. Never logged or exposed in events.
   */
  text: z.string().min(1).max(4_096),
});

export const scrollInputSchema = z.object({
  direction: z.enum(["up", "down", "left", "right"]),
  /** Number of scroll gestures. Capped by policy. */
  amount: z.number().int().min(1).max(20).default(1),
});

export type ClickInput = z.infer<typeof clickInputSchema>;
export type InputTextInput = z.infer<typeof inputTextSchema>;
export type ScrollInput = z.infer<typeof scrollInputSchema>;

export interface UiDependencies {
  controller: AndroidUiController;
  policy: UiPolicy;
}

const selectorJsonSchema = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "viewId" }, value: { type: "string" } },
      required: ["kind", "value"],
      description: "Android view ID - most stable, preferred.",
    },
    {
      type: "object",
      properties: { kind: { const: "text" }, value: { type: "string" } },
      required: ["kind", "value"],
      description: "Text displayed by the element.",
    },
    {
      type: "object",
      properties: { kind: { const: "contentDescription" }, value: { type: "string" } },
      required: ["kind", "value"],
      description: "Accessibility description of the element.",
    },
  ],
} as const;

/**
 * Checks that accessibility service is active now.
 */
async function assertAccessibility(
  dependencies: UiDependencies,
  capability: string,
): Promise<void> {
  if (!(await dependencies.controller.isAccessibilityEnabled())) {
    throw new AccessibilityDisabledError(capability);
  }
}

/** Resolves a selector to a node, rejecting nodes that do not accept the action. */
async function resolveNode(
  dependencies: UiDependencies,
  selector: UiSelector,
  action: "click" | "input",
) {
  if (selector.kind === "coordinates") return undefined;

  const node = await dependencies.controller.findNode(selector);
  if (node === undefined) throw new UiNodeNotFoundError(selector.kind);

  dependencies.policy.assertNodeAccepts(node, action);
  return node;
}

export function createUiClickCapability(
  dependencies: UiDependencies,
): LocalCapability<ClickInput, { clicked: boolean; selectorKind: string }> {
  return {
    name: "android.ui.click",
    description:
      "Taps an element on the Android phone screen, designated by view ID, text, or content description. " +
      "Requires NEXUS accessibility service.",
    inputSchema: clickInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: { selector: selectorJsonSchema },
      required: ["selector"],
    },
    riskLevel: "MEDIUM",

    probe: () => dependencies.controller.isAccessibilityEnabled(),

    execute: async (input, context) => {
      await assertAccessibility(dependencies, "android.ui.click");
      const selector = dependencies.policy.assertSelectorAllowed(input.selector);
      await resolveNode(dependencies, selector, "click");

      context.onProgress({ label: `tap on ${selector.kind}` });
      const result = await dependencies.controller.click(selector, context.signal);

      return { clicked: result.clicked, selectorKind: selector.kind };
    },
  };
}

export function createUiInputCapability(
  dependencies: UiDependencies,
): LocalCapability<InputTextInput, { entered: boolean; characters: number }> {
  return {
    name: "android.ui.input",
    description:
      "Inputs text into a field on the Android phone screen. " +
      "Requires NEXUS accessibility service.",
    inputSchema: inputTextSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        selector: selectorJsonSchema,
        text: { type: "string", description: "Text to enter into the field" },
      },
      required: ["selector", "text"],
    },
    riskLevel: "MEDIUM",

    secretArguments: ["text"],

    probe: () => dependencies.controller.isAccessibilityEnabled(),

    execute: async (input, context) => {
      await assertAccessibility(dependencies, "android.ui.input");
      const selector = dependencies.policy.assertSelectorAllowed(input.selector);
      const text = dependencies.policy.assertTextAllowed(input.text);
      await resolveNode(dependencies, selector, "input");

      context.onProgress({ label: `input of ${String(text.length)} characters` });

      const result = await dependencies.controller.inputText(selector, text, context.signal);

      return { entered: result.entered, characters: result.characters };
    },
  };
}

export function createUiScrollCapability(
  dependencies: UiDependencies,
): LocalCapability<ScrollInput, { scrolled: boolean; direction: string; amount: number }> {
  return {
    name: "android.ui.scroll",
    description:
      "Scrolls the Android phone screen in a given direction. " +
      "Requires NEXUS accessibility service.",
    inputSchema: scrollInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        direction: { enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Number of scroll gestures" },
      },
      required: ["direction"],
    },
    riskLevel: "LOW",

    probe: () => dependencies.controller.isAccessibilityEnabled(),

    execute: async (input, context) => {
      await assertAccessibility(dependencies, "android.ui.scroll");
      const { direction, amount } = dependencies.policy.assertScrollAllowed(
        input.direction,
        input.amount,
      );

      context.onProgress({ label: `scrolling ${direction}` });
      const result = await dependencies.controller.scroll(direction, amount, context.signal);

      return { scrolled: result.scrolled, direction, amount };
    },
  };
}

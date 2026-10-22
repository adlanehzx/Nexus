import { PolicyViolationError } from "@nexus/worker-core";
import type { ScrollDirection, UiSelector } from "../ports.js";

/**
 * UI automation policy.
 */

const MAX_SELECTOR_LENGTH = 256;
const MAX_INPUT_LENGTH = 4_096;
const MAX_SCROLL_AMOUNT = 20;

export interface UiPolicyOptions {
  /** Allows coordinate clicks. */
  allowCoordinateClicks?: boolean;
  /** Screen bounds, to reject out-of-screen coordinates. */
  screenBounds?: { width: number; height: number };
  maxInputLength?: number;
  maxScrollAmount?: number;
}

export class UiPolicy {
  readonly #allowCoordinates: boolean;
  readonly #bounds: { width: number; height: number } | undefined;
  readonly #maxInput: number;
  readonly #maxScroll: number;

  constructor(options: UiPolicyOptions = {}) {
    this.#allowCoordinates = options.allowCoordinateClicks ?? false;
    this.#bounds = options.screenBounds;
    this.#maxInput = options.maxInputLength ?? MAX_INPUT_LENGTH;
    this.#maxScroll = options.maxScrollAmount ?? MAX_SCROLL_AMOUNT;
  }

  get allowsCoordinates(): boolean {
    return this.#allowCoordinates;
  }

  /**
   * Validates a selector.
   *
   * @throws {PolicyViolationError} on empty, too long, or disallowed coordinates.
   */
  assertSelectorAllowed(selector: UiSelector): UiSelector {
    if (selector.kind === "coordinates") {
      if (!this.#allowCoordinates) {
        throw new PolicyViolationError({
          rule: "ui.coordinatesDisabled",
          message: "Coordinate taps disabled",
          userMessage:
            "Coordinate taps are disabled on this device: they hit a place on the " +
            "screen, not an identified element.",
        });
      }

      if (!Number.isFinite(selector.x) || !Number.isFinite(selector.y)) {
        throw new PolicyViolationError({
          rule: "ui.coordinatesInvalid",
          message: "Non-numeric coordinates",
        });
      }
      if (selector.x < 0 || selector.y < 0) {
        throw new PolicyViolationError({
          rule: "ui.coordinatesNegative",
          message: "Negative coordinates",
        });
      }
      if (
        this.#bounds !== undefined &&
        (selector.x > this.#bounds.width || selector.y > this.#bounds.height)
      ) {
        throw new PolicyViolationError({
          rule: "ui.coordinatesOutOfBounds",
          message: "Coordinates off screen",
          userMessage: "The target point is off screen.",
        });
      }

      return selector;
    }

    const value = selector.value.trim();
    if (value.length === 0) {
      throw new PolicyViolationError({
        rule: "ui.selectorEmpty",
        message: `Empty ${selector.kind} selector`,
      });
    }
    if (value.length > MAX_SELECTOR_LENGTH) {
      throw new PolicyViolationError({
        rule: "ui.selectorTooLong",
        message: `Selector ${selector.kind} too long`,
      });
    }

    return { kind: selector.kind, value };
  }

  /**
   * Validates text to input.
   */
  assertTextAllowed(text: string): string {
    if (text.length === 0) {
      throw new PolicyViolationError({
        rule: "ui.textEmpty",
        message: "Empty input text",
        userMessage: "No text to type was given.",
      });
    }
    if (text.length > this.#maxInput) {
      throw new PolicyViolationError({
        rule: "ui.textTooLong",
        message: `Input text too long (${String(text.length)} characters)`,
        userMessage: "The text to type exceeds the allowed length.",
        context: { length: text.length },
      });
    }
    if (text.includes("\0")) {
      throw new PolicyViolationError({
        rule: "ui.textNul",
        message: "Input text contains a null character",
      });
    }

    return text;
  }

  /** Validates scroll direction and amount. */
  assertScrollAllowed(
    direction: ScrollDirection,
    amount: number,
  ): { direction: ScrollDirection; amount: number } {
    if (!Number.isInteger(amount) || amount < 1) {
      throw new PolicyViolationError({
        rule: "ui.scrollAmount",
        message: `Invalid scroll amount: ${String(amount)}`,
        userMessage: "The scroll amount must be a positive integer.",
      });
    }
    if (amount > this.#maxScroll) {
      throw new PolicyViolationError({
        rule: "ui.scrollTooFar",
        message: `Excessive scroll amount: ${String(amount)}`,
        userMessage: `Scrolling is limited to ${String(this.#maxScroll)} gestures per operation.`,
        context: { amount, max: this.#maxScroll },
      });
    }

    return { direction, amount };
  }

  /**
   * Verifies that a node accepts the requested action.
   */
  assertNodeAccepts(
    node: { clickable: boolean; editable: boolean },
    action: "click" | "input",
  ): void {
    if (action === "click" && !node.clickable) {
      throw new PolicyViolationError({
        rule: "ui.nodeNotClickable",
        message: "Target element is not clickable",
        userMessage: "The target element does not accept a tap.",
      });
    }
    if (action === "input" && !node.editable) {
      throw new PolicyViolationError({
        rule: "ui.nodeNotEditable",
        message: "Target element is not an editable field",
        userMessage: "The target element is not a text field.",
      });
    }
  }
}

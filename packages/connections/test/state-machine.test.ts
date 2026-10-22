import { describe, expect, it } from "vitest";
import { connectionStateSchema, type ConnectionState } from "../src/model.js";
import {
  InvalidConnectionTransitionError,
  canTransition,
  nextStates,
  stateIsUsable,
  stateRequiresHumanAction,
  transition,
} from "../src/state-machine.js";

const ALL_STATES = connectionStateSchema.options;

describe("connection state machine", () => {
  it("only ever becomes connected by way of a probe", () => {
    // The central invariant, asserted exhaustively rather than by example: if a
    // new state is added with an edge straight to `connected`, this fails.
    const sources = ALL_STATES.filter((from) => canTransition(from, "connected"));

    // `testing` is the only way in. `connected` appears because re-asserting a
    // state already held is not a transition anybody needs to forbid.
    expect(sources.toSorted()).toEqual(["connected", "testing"]);
  });

  it("never becomes connected directly from an unproven state", () => {
    for (const from of [
      "not_installed",
      "detected",
      "authentication_required",
      "authenticating",
      "expired",
      "disconnected",
      "error",
    ] as ConnectionState[]) {
      expect(canTransition(from, "connected")).toBe(false);
    }
  });

  it("declares every state as a possible successor of itself", () => {
    // Re-detecting without a change must not be an error.
    for (const state of ALL_STATES) expect(canTransition(state, state)).toBe(true);
  });

  it("lists successors that are all real states", () => {
    for (const state of ALL_STATES) {
      for (const next of nextStates(state)) {
        expect(ALL_STATES).toContain(next);
      }
    }
  });

  it("throws on an impossible transition instead of returning the old state", () => {
    // Returning silently would let a caller carry on believing it set a state.
    expect(() => transition("not_installed", "connected")).toThrow(
      InvalidConnectionTransitionError,
    );
  });

  it("carries the attempted transition on the error", () => {
    try {
      transition("detected", "connected");
      expect.unreachable("the transition must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConnectionTransitionError);
      const typed = error as InvalidConnectionTransitionError;
      expect(typed.from).toBe("detected");
      expect(typed.to).toBe("connected");
      expect(typed.httpStatus).toBe(409);
      expect(typed.code).toBe("INVALID_CONNECTION_TRANSITION");
    }
  });

  it("returns the target state on a legal transition", () => {
    expect(transition("testing", "connected")).toBe("connected");
  });

  it("knows which states need a person rather than a retry", () => {
    expect(ALL_STATES.filter(stateRequiresHumanAction).toSorted()).toEqual([
      "authentication_required",
      "expired",
      "not_installed",
    ]);
  });

  it("knows which states mean the connection can be used", () => {
    expect(ALL_STATES.filter(stateIsUsable).toSorted()).toEqual(["connected", "degraded"]);
  });
});

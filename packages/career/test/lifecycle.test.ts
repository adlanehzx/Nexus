import { describe, expect, it } from "vitest";
import { ConflictError } from "@nexus/shared";
import { assertSubmittable, assertTransition } from "../src/lifecycle.js";
import {
  SUBMITTABLE_APPLICATION_STATE,
  TERMINAL_APPLICATION_STATES,
  allowedTransitions,
  applicationStateSchema,
  canTransition,
  isTerminalApplicationState,
  type ApplicationState,
} from "../src/vocabulary.js";

const ALL_STATES = applicationStateSchema.options;

describe("application lifecycle vocabulary", () => {
  it("declares exactly the eleven states of the contract", () => {
    expect(ALL_STATES).toEqual([
      "discovered",
      "shortlisted",
      "drafting",
      "awaiting_confirmation",
      "approved",
      "submitted",
      "interview",
      "offer",
      "rejected",
      "withdrawn",
      "expired",
    ]);
  });

  it("refuses any value outside the closed vocabulary", () => {
    expect(applicationStateSchema.safeParse("Submitted").success).toBe(false);
    expect(applicationStateSchema.safeParse("ready_to_submit").success).toBe(false);
  });

  it("has a transition row for every state", () => {
    for (const state of ALL_STATES) {
      expect(Array.isArray(allowedTransitions(state))).toBe(true);
    }
  });

  it("only ever transitions to states that exist", () => {
    const known = new Set<string>(ALL_STATES);
    for (const state of ALL_STATES) {
      for (const target of allowedTransitions(state)) expect(known.has(target)).toBe(true);
    }
  });

  it("never allows a self-transition", () => {
    for (const state of ALL_STATES) expect(canTransition(state, state)).toBe(false);
  });
});

describe("the three structural rules", () => {
  it("reaches approved only from awaiting_confirmation", () => {
    const sources = ALL_STATES.filter((state) => canTransition(state, "approved"));
    expect(sources).toEqual(["awaiting_confirmation"]);
  });

  it("reaches submitted only from approved", () => {
    const sources = ALL_STATES.filter((state) => canTransition(state, "submitted"));
    expect(sources).toEqual(["approved"]);
  });

  it("leaves terminal states with no way out", () => {
    for (const state of TERMINAL_APPLICATION_STATES) {
      expect(allowedTransitions(state)).toEqual([]);
      expect(isTerminalApplicationState(state)).toBe(true);
    }
  });

  it("keeps a refused confirmation distinct from a rejection", () => {
    // Going back to drafting is allowed; being marked rejected by the owner's
    // own refusal is not, because that would corrupt outcome statistics.
    expect(canTransition("awaiting_confirmation", "drafting")).toBe(true);
    expect(canTransition("awaiting_confirmation", "rejected")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("accepts every declared transition", () => {
    for (const from of ALL_STATES) {
      for (const to of allowedTransitions(from)) {
        expect(() => {
          assertTransition({ from, to, applicationId: "app-1" });
        }).not.toThrow();
      }
    }
  });

  it("refuses every undeclared transition with a conflict", () => {
    const forbidden: [ApplicationState, ApplicationState][] = [
      ["discovered", "submitted"],
      ["discovered", "approved"],
      ["drafting", "approved"],
      ["drafting", "submitted"],
      ["shortlisted", "submitted"],
      ["rejected", "drafting"],
      ["rejected", "submitted"],
      ["withdrawn", "shortlisted"],
      ["expired", "approved"],
      ["submitted", "approved"],
      ["offer", "submitted"],
    ];

    for (const [from, to] of forbidden) {
      expect(() => {
        assertTransition({ from, to, applicationId: "app-1" });
      }).toThrow(ConflictError);
    }
  });

  it("names the reachable states in the message a user sees", () => {
    try {
      assertTransition({ from: "discovered", to: "submitted", applicationId: "app-1" });
      expect.unreachable("the transition should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).userMessage).toContain("shortlisted");
    }
  });

  it("says a terminal state is final rather than listing nothing", () => {
    try {
      assertTransition({ from: "rejected", to: "drafting", applicationId: "app-1" });
      expect.unreachable("the transition should have been refused");
    } catch (error) {
      expect((error as ConflictError).userMessage).toContain("final");
    }
  });
});

describe("assertSubmittable", () => {
  it("accepts the approved state and nothing else", () => {
    expect(SUBMITTABLE_APPLICATION_STATE).toBe("approved");
    expect(() => {
      assertSubmittable({ state: "approved", applicationId: "app-1" });
    }).not.toThrow();

    for (const state of ALL_STATES.filter((candidate) => candidate !== "approved")) {
      expect(() => {
        assertSubmittable({ state, applicationId: "app-1" });
      }).toThrow(ConflictError);
    }
  });

  it("tells a rejected or expired owner that the door is closed, not that approval is pending", () => {
    for (const state of ["rejected", "expired", "withdrawn"] as const) {
      try {
        assertSubmittable({ state, applicationId: "app-1" });
        expect.unreachable("submission should have been refused");
      } catch (error) {
        expect((error as ConflictError).userMessage).toContain("no longer be submitted");
      }
    }
  });
});

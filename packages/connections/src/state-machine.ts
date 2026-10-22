import { AppError } from "@nexus/shared";
import type { ConnectionState } from "./model.js";

/**
 * Allowed transitions of a connection.
 *
 * ## Why a machine rather than a mutable field
 *
 * Because the illegal transitions are the interesting ones. Going from
 * `not_installed` straight to `connected` means a probe claimed success for
 * something that is not on the machine; from `detected` to `connected` without
 * passing through `testing` means somebody set a state they did not verify.
 * Both are plausible bugs, both would show a person a green badge for a
 * connection that does not work, and neither is detectable if the state is just
 * a string somebody assigns.
 *
 * ## The rule that shapes the table
 *
 * **A state is a claim, and the strength of a claim can only grow by
 * evidence.** `detected` claims an executable exists. `connected` claims a
 * probe answered. So every edge into `connected` comes from `testing`, which is
 * the only state that means "evidence is being gathered right now".
 *
 * Weakening is always allowed: anything can fail, expire, or vanish, and no
 * amount of past success prevents it. `not_installed` is therefore reachable
 * from every state without exception. A package manager removing a CLI does not
 * ask NEXUS first, and a model that refused to represent that would leave a
 * connection reading `connected` for something that is no longer on disk — the
 * one failure this whole file exists to prevent, arrived at from the other
 * direction.
 */
const TRANSITIONS: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = {
  // Something appeared on disk, or we are about to look.
  not_installed: ["detected", "testing", "error", "not_installed"],

  // Installed. From here we either probe, learn a sign-in is needed, or fail.
  detected: ["testing", "authentication_required", "error", "not_installed", "detected"],

  // A human has to sign in. They may start the flow, or we may re-detect.
  authentication_required: [
    "authenticating",
    "testing",
    "detected",
    "not_installed",
    "error",
    "authentication_required",
  ],

  // The provider's own sign-in flow is running. It can succeed, fail, or be
  // abandoned — never silently become `connected` without a probe. It can also
  // find the tool gone: a sign-in flow is exactly when somebody might be
  // uninstalling and reinstalling it.
  authenticating: [
    "testing",
    "authentication_required",
    "not_installed",
    "error",
    "authenticating",
  ],

  // The only state from which a success claim may be made.
  testing: [
    "connected",
    "degraded",
    // Weaker than where we came from, and allowed for that reason: a probe can
    // conclude "the tool is installed and I learned nothing about its session".
    // The invariant is that a claim only STRENGTHENS by evidence; falling back
    // to a weaker claim needs no evidence at all.
    "detected",
    "authentication_required",
    "expired",
    "disconnected",
    "error",
    "not_installed",
    "testing",
  ],

  // Working. Everything that can go wrong, can go wrong from here — including
  // the executable ceasing to exist. A package manager removing a CLI does not
  // consult NEXUS first, so refusing this edge would mean a connection stuck at
  // `connected` for a tool that is gone.
  connected: [
    "degraded",
    "expired",
    "disconnected",
    "testing",
    "not_installed",
    "error",
    "connected",
  ],

  // Working, but impaired. Recovery requires a probe, so there is deliberately
  // no direct edge to `connected`: an impairment that clears on its own is
  // still only a belief until something has run.
  degraded: ["testing", "expired", "disconnected", "not_installed", "error", "degraded"],

  // A session lapsed. A new session needs a human, or at least a fresh probe.
  expired: [
    "authentication_required",
    "authenticating",
    "testing",
    "error",
    "not_installed",
    "expired",
  ],

  // Unreachable, with no reason to suspect credentials.
  disconnected: ["testing", "detected", "not_installed", "error", "disconnected"],

  // A classified failure. Retrying means probing again.
  error: ["testing", "detected", "not_installed", "authentication_required", "error"],
};

export class InvalidConnectionTransitionError extends AppError {
  readonly code = "INVALID_CONNECTION_TRANSITION";
  readonly httpStatus = 409;
  readonly from: ConnectionState;
  readonly to: ConnectionState;

  constructor(from: ConnectionState, to: ConnectionState) {
    super({
      message: `invalid connection transition: ${from} → ${to}`,
      // Deliberately generic for the reader: an illegal transition is a defect
      // in NEXUS, not something a person did wrong, so the sentence must not
      // suggest they can fix it.
      userMessage: "NEXUS reached an inconsistent connection state and stopped to avoid guessing.",
      context: { from, to },
    });
    this.from = from;
    this.to = to;
  }
}

/** Can a connection move from `from` to `to`? */
export function canTransition(from: ConnectionState, to: ConnectionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Applies a transition, or throws.
 *
 * Throwing rather than returning the old state: a caller that ignores a
 * rejected transition would carry on with a state it believes it set. A loud
 * failure on an impossible path is cheaper than a silent one on every path
 * afterwards.
 */
export function transition(from: ConnectionState, to: ConnectionState): ConnectionState {
  if (!canTransition(from, to)) throw new InvalidConnectionTransitionError(from, to);
  return to;
}

/** Every state reachable from `from`, for a surface that offers choices. */
export function nextStates(from: ConnectionState): readonly ConnectionState[] {
  return TRANSITIONS[from];
}

/**
 * Is this state one a person has to act on?
 *
 * The three credential states need a human. `error` might, but the category
 * decides, so it is excluded here and answered by the provider instead — a
 * timeout needs patience, a permission denial needs a person.
 */
export function stateRequiresHumanAction(state: ConnectionState): boolean {
  return state === "authentication_required" || state === "expired" || state === "not_installed";
}

/** Is this state a working one, strongly or weakly? */
export function stateIsUsable(state: ConnectionState): boolean {
  return state === "connected" || state === "degraded";
}

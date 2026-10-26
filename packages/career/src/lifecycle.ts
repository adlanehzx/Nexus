import { ConflictError } from "@nexus/shared";
import {
  SUBMITTABLE_APPLICATION_STATE,
  allowedTransitions,
  canTransition,
  isTerminalApplicationState,
  type ApplicationState,
} from "./vocabulary.js";

/**
 * The lifecycle guard.
 *
 * The transition table in `vocabulary.ts` says what is legal; this module is
 * what makes illegality *fail*. The separation matters because the table is
 * read by surfaces that want to offer the right buttons, while this function is
 * called by the service that must refuse the wrong ones — and a surface that
 * forgets to filter its buttons must still not be able to drive the model into
 * a state the table forbids.
 *
 * Refusal is a `ConflictError`, not a validation error: the request was
 * well-formed, it was the *state of the world* that rejected it. The user
 * message says which states are reachable, because that is useful and leaks
 * nothing — the vocabulary is public, only the data is private.
 */

export interface TransitionAttempt {
  from: ApplicationState;
  to: ApplicationState;
  /** Opaque identifier, included in the internal message only. */
  applicationId: string;
}

export function assertTransition(attempt: TransitionAttempt): void {
  if (canTransition(attempt.from, attempt.to)) return;

  const reachable = allowedTransitions(attempt.from);
  const detail = isTerminalApplicationState(attempt.from)
    ? `${attempt.from} is final`
    : `from ${attempt.from} only ${reachable.join(", ")} are reachable`;

  throw new ConflictError({
    message: `Invalid application transition ${attempt.from} -> ${attempt.to} (${detail})`,
    userMessage: `This application cannot move to ${attempt.to}: ${detail}.`,
    context: { applicationId: attempt.applicationId, from: attempt.from, to: attempt.to },
  });
}

/**
 * The submission gate, stated once.
 *
 * Separate from `assertTransition` even though the transition table already
 * forbids `rejected -> submitted`, because the two answer different questions
 * and the caller asks them at different moments. The service checks *this* one
 * before it looks at a confirmation or touches an adapter, so a rejected or
 * expired application is turned away before any work is done on its behalf —
 * and the error says so plainly rather than talking about transitions.
 */
export function assertSubmittable(input: { state: ApplicationState; applicationId: string }): void {
  if (input.state === SUBMITTABLE_APPLICATION_STATE) return;

  throw new ConflictError({
    message: `Submission refused: application is ${input.state}, not ${SUBMITTABLE_APPLICATION_STATE}`,
    userMessage: isTerminalApplicationState(input.state)
      ? `This application is ${input.state} and can no longer be submitted.`
      : "This application must be approved before it can be submitted.",
    context: { applicationId: input.applicationId, state: input.state },
  });
}

/**
 * Failure model shared by every screen.
 *
 * A phone sees failures a desktop rarely does, and each one calls for a
 * different answer: an administrator-only section is not an outage, and an
 * installation without a feature is not a bug. Screens render these kinds
 * instead of a raw message so a missing capability never looks like a broken app.
 */

export type FailureKind =
  /** The device has no network, or the core cannot be reached. */
  | "network"
  /** Session expired or refused. */
  | "auth"
  /** The account lacks the role. */
  | "forbidden"
  /** The resource does not exist. */
  | "notFound"
  /** The route exists; its dependency is not configured or connected. */
  | "unavailable"
  /** Anything else the server refused. */
  | "server";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface Failure {
  kind: FailureKind;
  title: string;
  message: string;
  /** Whether trying again could change the outcome. */
  retryable: boolean;
}

export function describeFailure(cause: unknown): Failure {
  if (cause instanceof ApiError) return describeApiError(cause);

  // `NotAuthenticatedError`, or a session cleared by a refused refresh.
  const code = (cause as { code?: unknown } | null)?.code;
  if (
    typeof code === "string" &&
    (code === "CLIENT_NOT_AUTHENTICATED" || code.startsWith("AUTH"))
  ) {
    return {
      kind: "auth",
      title: "Session expired",
      message: "Sign in again to continue.",
      retryable: false,
    };
  }

  if (code === "CLIENT_REQUEST_BLOCKED" || isAbort(cause) || isNetworkError(cause)) {
    return {
      kind: "network",
      title: "Can't reach NEXUS",
      message: "Check your connection and that the core is running.",
      retryable: true,
    };
  }

  return {
    kind: "server",
    title: "Something went wrong",
    message: cause instanceof Error ? cause.message : "The request failed.",
    retryable: true,
  };
}

function describeApiError(error: ApiError): Failure {
  if (error.status === 401) {
    return {
      kind: "auth",
      title: "Session expired",
      message: "Sign in again to continue.",
      retryable: false,
    };
  }
  if (error.status === 403) {
    return {
      kind: "forbidden",
      title: "Administrator access required",
      message: error.message,
      retryable: false,
    };
  }
  if (error.status === 404) {
    // The core answers a missing record and an unknown route identically, so an
    // older core without a feature lands here too.
    return {
      kind: "notFound",
      title: "Not found",
      message: "This item does not exist, or this NEXUS core does not provide it.",
      retryable: false,
    };
  }
  if (error.status === 502 || error.status === 503 || error.status === 504) {
    return {
      kind: "unavailable",
      title: "Service not available",
      message: error.message,
      retryable: true,
    };
  }
  return {
    kind: "server",
    title: "The server refused the request",
    message: error.message,
    retryable: error.status >= 500,
  };
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

function isNetworkError(cause: unknown): boolean {
  return cause instanceof TypeError && /network|fetch/i.test(cause.message);
}

/** One-line message for an action that failed, for alerts and inline errors. */
export function failureMessage(cause: unknown): string {
  const failure = describeFailure(cause);
  return failure.kind === "server" || failure.kind === "forbidden"
    ? failure.message
    : `${failure.title}. ${failure.message}`;
}

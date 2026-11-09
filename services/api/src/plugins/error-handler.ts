import fp from "fastify-plugin";
import type { FastifyInstance, FastifyError, FastifyReply, FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import {
  AppError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  toAppError,
} from "@nexus/shared";
import type { ErrorResponse } from "@nexus/protocol";

/**
 * Single error handler.
 *
 * Three guarantees:
 *   1. The client always receives the same shape — `{ error: { code, message,
 *      retryable, correlationId } }` — regardless of where the failure occurred.
 *   2. No stack trace, no internal details cross the boundary.
 *      They go into logs, correlated by `correlationId`.
 *   3. `code` is a public, stable contract: clients can bind against it.
 */

function buildResponse(error: AppError, correlationId: string): ErrorResponse {
  return { error: { ...error.toPublicJSON(), correlationId } };
}

export const errorHandlerPlugin = fp(
  function errorHandler(app: FastifyInstance, _options: unknown, done: () => void) {
    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      const error = new NotFoundError({
        message: `Unknown route: ${request.method} ${request.url}`,
      });
      request.log.info({ event: "http.not_found", method: request.method, path: request.url });
      void reply.status(error.httpStatus).send(buildResponse(error, request.id));
    });

    app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const appError = translate(error);

      // A client error (4xx) is an expected event, not an incident:
      // logging it as 'error' would render alerts unusable.
      const level = appError.httpStatus >= 500 ? "error" : "warn";
      request.log[level](
        {
          event: "http.error",
          code: appError.code,
          status: appError.httpStatus,
          method: request.method,
          path: request.url,
          context: appError.context,
          err: appError,
        },
        appError.message,
      );

      void reply.status(appError.httpStatus).send(buildResponse(appError, request.id));
    });

    done();
  },
  { name: "error-handler" },
);

/** Maps any error — Fastify, Zod, or unexpected — to our taxonomy. */
function translate(
  error:
    | FastifyError
    | (Error & { statusCode?: number; code?: string; httpStatus?: number; userMessage?: string }),
): AppError {
  if (error instanceof AppError) return error;

  // Duck typing for AppError (preserves code & httpStatus across bundle boundaries)
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "httpStatus" in error &&
    typeof (error as { httpStatus: unknown }).httpStatus === "number" &&
    typeof (error as { toPublicJSON?: unknown }).toPublicJSON === "function"
  ) {
    return error as unknown as AppError;
  }

  // Any explicit 404 or NotFoundError must return a NotFoundError (HTTP 404)
  if (
    error?.name === "NotFoundError" ||
    error?.name === "DeviceNotFoundError" ||
    (error as { code?: string })?.code === "NOT_FOUND" ||
    (error as { code?: string })?.code === "DEVICE_NOT_FOUND" ||
    error.statusCode === 404 ||
    (error as { httpStatus?: number })?.httpStatus === 404
  ) {
    return new NotFoundError({
      message: error.message || "Resource not found",
      userMessage: (error as { userMessage?: string })?.userMessage ?? "Resource not found.",
    });
  }

  if (hasZodFastifySchemaValidationErrors(error as FastifyError)) {
    return new ValidationError({
      message: "Request validation failed",
      context: { issues: (error as FastifyError).validation },
    });
  }

  if (isResponseSerializationError(error as FastifyError)) {
    // A response that does not respect its own schema is a server bug,
    // never a client error. The schema violation details accompany the
    // message: without them, diagnosis was reduced to "somewhere in this route",
    // which is exactly what cost an evening on lastSeenAt.
    const errObj = error as { method?: string; url?: string };
    return toAppError(
      new Error(
        `Response does not match schema on ${errObj.method ?? ""} ${errObj.url ?? ""}: ${error.message}`,
      ),
    );
  }

  if (error.statusCode === 429) {
    return new RateLimitError({ message: error.message });
  }

  if (typeof error.statusCode === "number" && error.statusCode < 500) {
    return new ValidationError({ message: error.message });
  }

  if (typeof (error as { httpStatus?: number })?.httpStatus === "number") {
    const status = (error as { httpStatus: number }).httpStatus;
    if (status === 404) {
      return new NotFoundError({
        message: error.message || "Resource not found",
        userMessage: (error as { userMessage?: string })?.userMessage ?? "Resource not found.",
      });
    }
  }

  return toAppError(error);
}

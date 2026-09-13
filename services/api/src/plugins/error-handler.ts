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
 * Gestionnaire d'erreurs unique.
 *
 * Trois garanties :
 *   1. Le client reçoit toujours la même forme — `{ error: { code, message,
 *      retryable, correlationId } }` — quel que soit l'endroit où ça a cassé.
 *   2. Aucune trace d'exécution, aucun détail interne ne franchit la frontière.
 *      Ils partent dans les logs, corrélés par `correlationId`.
 *   3. `code` est un contrat public et stable : un client peut se brancher dessus.
 */

function buildResponse(error: AppError, correlationId: string): ErrorResponse {
  return { error: { ...error.toPublicJSON(), correlationId } };
}

export const errorHandlerPlugin = fp(
  function errorHandler(app: FastifyInstance, _options: unknown, done: () => void) {
    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      const error = new NotFoundError({
        message: `Route inconnue : ${request.method} ${request.url}`,
      });
      request.log.info({ event: "http.not_found", method: request.method, path: request.url });
      void reply.status(error.httpStatus).send(buildResponse(error, request.id));
    });

    app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const appError = translate(error);

      // Une erreur client (4xx) est un événement attendu, pas un incident :
      // la journaliser en `error` rendrait les alertes inutilisables.
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

/** Ramène toute erreur — Fastify, Zod, ou inattendue — à notre taxonomie. */
function translate(error: FastifyError): AppError {
  if (error instanceof AppError) return error;

  if (hasZodFastifySchemaValidationErrors(error)) {
    return new ValidationError({
      message: "Échec de validation de la requête",
      context: { issues: error.validation },
    });
  }

  if (isResponseSerializationError(error)) {
    // Une réponse qui ne respecte pas son propre schéma est un bug serveur,
    // jamais une erreur du client. Le détail du schéma violé accompagne le
    // message : sans lui, le diagnostic se réduisait à « quelque part dans
    // cette route », et c'est exactement ce qui a coûté une soirée sur
    // `lastSeenAt`.
    return toAppError(
      new Error(
        `Réponse non conforme au schéma sur ${error.method} ${error.url} : ${error.message}`,
      ),
    );
  }

  if (error.statusCode === 429) {
    return new RateLimitError({ message: error.message });
  }

  if (typeof error.statusCode === "number" && error.statusCode < 500) {
    return new ValidationError({ message: error.message });
  }

  return toAppError(error);
}

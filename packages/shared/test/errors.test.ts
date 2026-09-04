import { describe, expect, it } from "vitest";
import {
  AppError,
  ConfigurationError,
  DependencyError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  isAppError,
  toAppError,
} from "../src/errors.js";

describe("AppError", () => {
  it("expose un code et un statut HTTP stables", () => {
    const error = new NotFoundError({ message: "conversation absente" });
    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });

  it("ne laisse jamais fuir le contexte technique dans la charge publique", () => {
    const error = new ValidationError({
      message: "email invalide",
      context: { query: "SELECT * FROM users", secret: "sk-live-123" },
    });

    const publicJson = error.toPublicJSON();
    expect(publicJson).toEqual({
      code: "VALIDATION_ERROR",
      message: "La requête est invalide.",
      retryable: false,
    });
    expect(JSON.stringify(publicJson)).not.toContain("sk-live-123");
  });

  it("permet de surcharger le message utilisateur", () => {
    const error = new NotFoundError({
      message: "interne",
      userMessage: "Cette conversation n'existe plus.",
    });
    expect(error.toPublicJSON().message).toBe("Cette conversation n'existe plus.");
  });

  it("marque comme réessayables les seules erreurs qui le sont", () => {
    expect(new RateLimitError({ message: "quota" }).retryable).toBe(true);
    expect(new DependencyError({ message: "postgres down" }).retryable).toBe(true);
    expect(new ValidationError({ message: "champ manquant" }).retryable).toBe(false);
    expect(new NotFoundError({ message: "absent" }).retryable).toBe(false);
  });

  it("conserve la cause d'origine", () => {
    const cause = new Error("ECONNREFUSED");
    const error = new DependencyError({ message: "redis injoignable", cause });
    expect(error.cause).toBe(cause);
  });

  it("classe une erreur de configuration comme fatale", () => {
    expect(new ConfigurationError({ message: "DATABASE_URL manquante" }).severity).toBe("fatal");
  });
});

describe("toAppError", () => {
  it("laisse passer une AppError inchangée", () => {
    const original = new NotFoundError({ message: "x" });
    expect(toAppError(original)).toBe(original);
  });

  it("enveloppe une Error native", () => {
    const converted = toAppError(new Error("boum"));
    expect(isAppError(converted)).toBe(true);
    expect(converted.code).toBe("INTERNAL_ERROR");
    expect(converted.httpStatus).toBe(500);
  });

  it("enveloppe une valeur non typée sans planter", () => {
    // Le pipeline d'erreurs ne doit jamais rencontrer une valeur qu'il ne sait
    // pas traiter — y compris un `throw "chaîne"`.
    const converted = toAppError("échec brut");
    expect(converted).toBeInstanceOf(AppError);
    expect(converted.context).toEqual({ raw: "échec brut" });
  });
});

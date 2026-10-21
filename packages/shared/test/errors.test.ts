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
  it("exposes stable public error codes and HTTP statuses", () => {
    const error = new NotFoundError({ message: "missing conversation" });
    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });

  it("never leaks technical context into public payloads", () => {
    const error = new ValidationError({
      message: "invalid email",
      context: { query: "SELECT * FROM users", secret: "sk-live-123" },
    });

    const publicJson = error.toPublicJSON();
    expect(publicJson).toEqual({
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
      retryable: false,
    });
    expect(JSON.stringify(publicJson)).not.toContain("sk-live-123");
  });

  it("allows overriding the user message", () => {
    const error = new NotFoundError({
      message: "internal",
      userMessage: "This conversation no longer exists.",
    });
    expect(error.toPublicJSON().message).toBe("This conversation no longer exists.");
  });

  it("marks as retryable only genuinely retryable errors", () => {
    expect(new RateLimitError({ message: "quota" }).retryable).toBe(true);
    expect(new DependencyError({ message: "postgres down" }).retryable).toBe(true);
    expect(new ValidationError({ message: "missing field" }).retryable).toBe(false);
    expect(new NotFoundError({ message: "missing" }).retryable).toBe(false);
  });

  it("preserves the original cause", () => {
    const cause = new Error("ECONNREFUSED");
    const error = new DependencyError({ message: "redis unreachable", cause });
    expect(error.cause).toBe(cause);
  });

  it("classifies configuration errors as fatal", () => {
    expect(new ConfigurationError({ message: "missing DATABASE_URL" }).severity).toBe("fatal");
  });
});

describe("toAppError", () => {
  it("passes through an existing AppError unchanged", () => {
    const original = new NotFoundError({ message: "x" });
    expect(toAppError(original)).toBe(original);
  });

  it("wraps a native Error", () => {
    const converted = toAppError(new Error("boom"));
    expect(isAppError(converted)).toBe(true);
    expect(converted.code).toBe("INTERNAL_ERROR");
    expect(converted.httpStatus).toBe(500);
  });

  it("wraps untyped values without crashing", () => {
    const converted = toAppError("raw failure");
    expect(converted).toBeInstanceOf(AppError);
    expect(converted.context).toEqual({ raw: "raw failure" });
  });
});

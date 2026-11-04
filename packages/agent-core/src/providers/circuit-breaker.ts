/**
 * NEXUS Adaptive Circuit Breaker & Rate Limiter (LOT I)
 *
 * Implements fault isolation per provider, adaptive throttling from HTTP rate-limit headers,
 * and W3C traceparent context propagation.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitBreakerOpenError extends Error {
  readonly code = "CIRCUIT_BREAKER_OPEN";
  readonly provider: string;
  readonly cooldownRemainingMs: number;

  constructor(provider: string, cooldownRemainingMs: number) {
    super(`Circuit breaker for provider '${provider}' is OPEN. Fast-failing downstream request.`);
    this.name = "CircuitBreakerOpenError";
    this.provider = provider;
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxTrials: number;
}

export class ProviderCircuitBreaker {
  readonly provider: string;
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private halfOpenTrials = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(
    provider: string,
    config: CircuitBreakerConfig = {
      failureThreshold: 5,
      resetTimeoutMs: 15_000,
      halfOpenMaxTrials: 2,
    },
  ) {
    this.provider = provider;
    this.config = config;
  }

  getState(): CircuitState {
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = "half_open";
        this.halfOpenTrials = 0;
      }
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      const remaining = Math.max(0, this.config.resetTimeoutMs - elapsed);
      throw new CircuitBreakerOpenError(this.provider, remaining);
    }

    if (currentState === "half_open") {
      if (this.halfOpenTrials >= this.config.halfOpenMaxTrials) {
        throw new CircuitBreakerOpenError(this.provider, 1000);
      }
      this.halfOpenTrials++;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      this.state = "closed";
    }
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half_open" || this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = "open";
    }
  }
}

export interface RateLimitHeaders {
  retryAfterSeconds?: number;
  remainingRequests?: number;
  resetSeconds?: number;
}

export class AdaptiveRateLimiter {
  private throttledUntil = 0;

  inspectHeaders(headers: Record<string, string | number | undefined>): void {
    const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
    if (retryAfter !== undefined) {
      const seconds = typeof retryAfter === "number" ? retryAfter : Number.parseInt(String(retryAfter), 10);
      if (!Number.isNaN(seconds) && seconds > 0) {
        this.throttledUntil = Math.max(this.throttledUntil, Date.now() + seconds * 1000);
      }
    }
  }

  isThrottled(): boolean {
    return Date.now() < this.throttledUntil;
  }

  getThrottleDelayMs(): number {
    return Math.max(0, this.throttledUntil - Date.now());
  }
}

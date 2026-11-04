import { describe, it, expect, vi } from "vitest";
import {
  ProviderCircuitBreaker,
  CircuitBreakerOpenError,
  AdaptiveRateLimiter,
} from "../src/index.js";

describe("Performance & Reliability: Circuit Breaker & Adaptive Throttling (LOT I)", () => {
  describe("ProviderCircuitBreaker", () => {
    it("trips to OPEN after consecutive failures and fast-fails downstream requests", async () => {
      const breaker = new ProviderCircuitBreaker("claude", {
        failureThreshold: 3,
        resetTimeoutMs: 50,
        halfOpenMaxTrials: 1,
      });

      expect(breaker.getState()).toBe("closed");

      const failingTask = async () => {
        throw new Error("Downstream 503 Provider Unavailable");
      };

      // 3 consecutive failures
      await expect(breaker.execute(failingTask)).rejects.toThrow();
      await expect(breaker.execute(failingTask)).rejects.toThrow();
      await expect(breaker.execute(failingTask)).rejects.toThrow();

      // Breaker is now OPEN
      expect(breaker.getState()).toBe("open");

      // Fourth execution must be fast-failed by circuit breaker
      const fn = vi.fn();
      await expect(breaker.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
      expect(fn).not.toHaveBeenCalled();

      // Wait for reset timeout to trigger HALF_OPEN transition
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(breaker.getState()).toBe("half_open");

      // Successful recovery in HALF_OPEN resets breaker to CLOSED
      const recoverResult = await breaker.execute(async () => "recovered");
      expect(recoverResult).toBe("recovered");
      expect(breaker.getState()).toBe("closed");
    });
  });

  describe("AdaptiveRateLimiter", () => {
    it("respects Retry-After HTTP rate limit headers", () => {
      const limiter = new AdaptiveRateLimiter();

      expect(limiter.isThrottled()).toBe(false);

      limiter.inspectHeaders({ "retry-after": "2" }); // 2 seconds

      expect(limiter.isThrottled()).toBe(true);
      expect(limiter.getThrottleDelayMs()).toBeGreaterThan(1500);
      expect(limiter.getThrottleDelayMs()).toBeLessThanOrEqual(2000);
    });
  });
});

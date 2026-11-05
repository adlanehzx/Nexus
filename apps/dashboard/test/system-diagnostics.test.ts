import { describe, expect, it } from "vitest";
import { redactSensitiveSecrets } from "../src/ui/sections/observability.js";

describe("System Diagnostics & Observability Contracts (Mission D)", () => {
  it("redacts bearer tokens and API keys from logs", () => {
    const raw =
      "Request failed with Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID and key sk-ant-api03-abcdef123456789";
    const redacted = redactSensitiveSecrets(raw);
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redacted).not.toContain("sk-ant-api03-abcdef123456789");
    expect(redacted).toContain("[REDACTED_TOKEN]");
    expect(redacted).toContain("[REDACTED_API_KEY]");
  });

  it("redacts GitHub personal access tokens and passwords", () => {
    const raw =
      "Git clone failed: remote https://ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com, password=supersecret";
    const redacted = redactSensitiveSecrets(raw);
    expect(redacted).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(redacted).toContain("password=[REDACTED]");
  });

  it("leaves non-sensitive operational error messages intact", () => {
    const raw = "Worker connection timed out on step execute_tool (task-id: t-1024)";
    const redacted = redactSensitiveSecrets(raw);
    expect(redacted).toBe(raw);
  });
});

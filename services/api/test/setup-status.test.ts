import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, makeApi, type ApiHarness } from "./harness.js";

describe("first-run setup status", () => {
  let harness: ApiHarness;

  beforeEach(async () => {
    harness = await makeApi();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("is public and changes only after an account exists", async () => {
    const before = await harness.app.inject({
      method: "GET",
      url: "/api/v1/auth/setup-status",
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().data).toEqual({ initialized: false });

    await createAccount(harness, "first-run@example.test");

    const after = await harness.app.inject({
      method: "GET",
      url: "/api/v1/auth/setup-status",
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().data).toEqual({ initialized: true });
  });
});

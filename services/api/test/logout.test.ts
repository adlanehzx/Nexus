import { afterEach, describe, expect, it } from "vitest";
import { createAccount, makeApi, type ApiHarness } from "./harness.js";

describe("POST /auth/logout", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  it("closes the session for a client sending no body and no parameter", async () => {
    harness = await makeApi();
    const account = await createAccount(harness, "logout@example.test");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: account.authorization,
    });
    expect(response.statusCode).toBe(200);

    const after = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: account.authorization,
    });
    expect(after.statusCode).toBe(401);
  });
});

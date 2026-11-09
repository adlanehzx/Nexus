import { expect, it } from "vitest";
import { makeApi, createAccount } from "./harness.js";

it("validates mission inputs, requires authentication and isolates mission owners", async () => {
  const h = await makeApi();
  try {
    const owner = await createAccount(h, "osint-mission-owner@example.test");
    const other = await createAccount(h, "osint-mission-other@example.test");
    const payload = {
      title: "Public target review",
      targets: [{ type: "domain", value: "example.org" }],
      lawfulPurposeConfirmed: true,
    };
    expect(
      (await h.app.inject({ method: "POST", url: "/api/v1/osint/missions", payload })).statusCode,
    ).toBe(401);
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/v1/osint/missions",
          headers: owner.authorization,
          payload: { ...payload, targets: [] },
        })
      ).statusCode,
    ).toBe(400);
    const result = await h.app.inject({
      method: "POST",
      url: "/api/v1/osint/missions",
      headers: owner.authorization,
      payload,
    });
    expect(result.statusCode).toBe(200);
    const id = result.json().data.id;
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: `/api/v1/osint/missions/${id}`,
          headers: other.authorization,
        })
      ).statusCode,
    ).toBe(404);
    const list = await h.app.inject({
      method: "GET",
      url: "/api/v1/osint/missions",
      headers: other.authorization,
    });
    expect(list.json().data.missions).toEqual([]);
    const own = await h.app.inject({
      method: "GET",
      url: `/api/v1/osint/missions/${id}`,
      headers: owner.authorization,
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().data.timeline.length).toBeGreaterThan(0);
  } finally {
    await h.close();
  }
});

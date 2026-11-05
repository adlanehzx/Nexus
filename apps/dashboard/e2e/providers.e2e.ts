import { expect, test } from "@playwright/test";
import { promoteToAdmin } from "./seed.js";
import { API_URL, EVIDENCE_DIR, openFromPalette, registerAccount, signIn } from "./support.js";

test("A — Providers shows real host detection, never a claimed connection", async ({
  page,
  request,
}) => {
  const admin = await registerAccount(request, "providers-admin");
  promoteToAdmin(admin.id);
  await signIn(page, admin);
  await openFromPalette(page, "Providers");

  const status = page.getByRole("heading", { name: /Status on this host/ });
  await status.scrollIntoViewIfNeeded();
  await expect(status).toBeInViewport();
  // The former hard-coded "100 % coverage" and "9 active engines" tiles must stay gone.
  await expect(page.locator(".metric", { hasText: /coverage|active engines/ })).toHaveCount(0);

  await page.getByRole("button", { name: /Detect installed CLIs/ }).click();
  await expect(page.getByRole("button", { name: /Detect installed CLIs/ })).toBeEnabled({
    timeout: 45_000,
  });

  // What the screen shows must be exactly what the server observed.
  const response = await request.get(`${API_URL}/api/v1/connections`, {
    headers: { authorization: `Bearer ${admin.accessToken}` },
  });
  const { data } = (await response.json()) as {
    data: {
      connections: {
        providerId: string;
        observation: { state: string; version: string | null; authStatus: string } | null;
      }[];
    };
  };
  expect(data.connections.length).toBeGreaterThan(0);
  for (const { providerId, observation } of data.connections) {
    const row = page.locator(`tr[data-provider="${providerId}"]`);
    if (observation !== null) await expect(row).toContainText(observation.state);
    if (observation?.version != null) await expect(row).toContainText(observation.version);
    if (observation !== null) {
      await expect(row.locator("td[data-auth]")).toHaveAttribute(
        "data-auth",
        observation.authStatus,
      );
    }
  }
  // The chat's engine buttons changed nothing, so they must stay gone.
  await expect(page.getByRole("button", { name: "Claude 3.5" })).toHaveCount(0);
  await page.locator(`tr[data-provider]`).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE_DIR}/providers.png` });
});

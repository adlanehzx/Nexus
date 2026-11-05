import { expect, test } from "@playwright/test";
import { promoteToAdmin } from "./seed.js";
import { API_URL, EVIDENCE_DIR, openFromPalette, registerAccount, signIn } from "./support.js";

test("G — a controlled error can be found in the interface from its correlation id", async ({
  page,
  request,
}) => {
  const admin = await registerAccount(request, "observability-admin");
  promoteToAdmin(admin.id);

  const failing = await request.get(
    `${API_URL}/api/v1/organizations/00000000-0000-4000-8000-000000000000`,
    { headers: { authorization: `Bearer ${admin.accessToken}` } },
  );
  expect(failing.status()).toBe(404);
  const correlationId = failing.headers()["x-request-id"] ?? "";
  expect(correlationId.length).toBeGreaterThan(0);

  await signIn(page, admin);
  await openFromPalette(page, "Observability");
  await expect(page.getByRole("heading", { name: /^Observability|^Observabilité/ })).toBeVisible();
  await expect(page.getByTestId("engine-status")).toContainText(/reachable|accessible/);

  await page.getByLabel(/Correlation ID or message|Identifiant de corrélation/).fill(correlationId);
  await page.getByRole("button", { name: /^Search$|^Rechercher$/ }).click();
  await expect(page.locator(`tr[data-log-correlation="${correlationId}"]`).first()).toBeVisible();
  await page
    .locator(`tr[data-log-correlation="${correlationId}"]`)
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE_DIR}/observability.png` });

  // A plain account cannot read these traces, in the interface or the API.
  const member = await registerAccount(request, "observability-member");
  const refused = await request.get(`${API_URL}/api/v1/dashboard/logs`, {
    headers: { authorization: `Bearer ${member.accessToken}` },
  });
  expect(refused.status()).toBe(403);
});

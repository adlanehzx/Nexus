import { expect, test } from "@playwright/test";
import { sql } from "./seed.js";
import {
  API_URL,
  EVIDENCE_DIR,
  openFromPalette,
  registerAccount,
  signIn,
  type Account,
} from "./support.js";

const auth = (account: Account) => ({ authorization: `Bearer ${account.accessToken}` });

test("F — two tenants stay isolated in the interface and the API", async ({ page, request }) => {
  const alice = await registerAccount(request, "tenant-alice");
  const mallory = await registerAccount(request, "tenant-mallory");
  const member = await registerAccount(request, "tenant-member");
  const slug = `acme-${String(Date.now())}`;

  await signIn(page, alice);
  await openFromPalette(page, "Organizations");
  await page.getByLabel(/Organization name|Nom de l’organisation/).fill("Acme");
  await page.getByLabel(/^Identifier|^Identifiant/).fill(slug);
  await page.getByRole("button", { name: /Create organization|Créer l’organisation/ }).click();
  const row = page.locator(`tr[data-organization="${slug}"]`);
  await expect(row).toContainText("OWNER");

  await row.getByRole("button", { name: /Members|Membres/ }).click();
  await page.getByLabel(/Member email|E-mail du membre/).fill(member.email);
  await page.getByRole("button", { name: /Add member|Ajouter le membre/ }).click();
  await expect(page.locator(`tr[data-member="${member.email}"]`)).toContainText("MEMBER");
  await page.screenshot({ path: `${EVIDENCE_DIR}/organizations.png` });

  const { data: aliceData } = (await (
    await request.get(`${API_URL}/api/v1/organizations`, { headers: auth(alice) })
  ).json()) as { data: { organizations: { id: string; slug: string }[] } };
  const acme = aliceData.organizations.find((org) => org.slug === slug);
  if (acme === undefined) throw new Error("Acme was not created");

  // Mallory's list does not mention Acme, and direct requests by id are refused.
  const { data: malloryData } = (await (
    await request.get(`${API_URL}/api/v1/organizations`, { headers: auth(mallory) })
  ).json()) as { data: { organizations: { slug: string }[] } };
  expect(malloryData.organizations.map((org) => org.slug)).not.toContain(slug);

  for (const attempt of [
    request.get(`${API_URL}/api/v1/organizations/${acme.id}`, { headers: auth(mallory) }),
    request.get(`${API_URL}/api/v1/organizations/${acme.id}/members`, { headers: auth(mallory) }),
    request.post(`${API_URL}/api/v1/organizations/${acme.id}/members`, {
      headers: auth(mallory),
      data: { email: mallory.email, role: "OWNER" },
    }),
    request.get(`${API_URL}/api/v1/organizations/${acme.id}/usage`, { headers: auth(mallory) }),
  ]) {
    const response = await attempt;
    expect([403, 404], `${response.url()} → ${String(response.status())}`).toContain(
      response.status(),
    );
  }

  // A plain member can read but not change the membership.
  const escalation = await request.post(`${API_URL}/api/v1/organizations/${acme.id}/members`, {
    headers: auth(member),
    data: { email: member.email, role: "OWNER" },
  });
  expect([403, 404]).toContain(escalation.status());

  // Managing members is not a path to ownership: an ORG_ADMIN cannot take over.
  const promoted = await request.post(`${API_URL}/api/v1/organizations/${acme.id}/members`, {
    headers: auth(alice),
    data: { email: member.email, role: "ORG_ADMIN" },
  });
  expect(promoted.status()).toBe(200);
  for (const data of [
    { email: member.email, role: "OWNER" },
    { email: alice.email, role: "MEMBER" },
  ]) {
    const takeover = await request.post(`${API_URL}/api/v1/organizations/${acme.id}/members`, {
      headers: auth(member),
      data,
    });
    expect(takeover.status()).toBe(404);
  }
  expect(
    sql(
      `SELECT count(*) FROM tenant_audit_events WHERE "organizationId" = '${acme.id}' AND action = 'organization.member_role_set';`,
    ),
  ).toBe("2");

  // Mallory's interface shows only their personal organization.
  await page.context().clearCookies();
  await page.evaluate(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });
  await signIn(page, mallory);
  await openFromPalette(page, "Organizations");
  await expect(page.getByRole("heading", { name: /^Organizations|^Organisations/ })).toBeVisible();
  await expect(page.locator("tr[data-organization]")).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText(slug);
});

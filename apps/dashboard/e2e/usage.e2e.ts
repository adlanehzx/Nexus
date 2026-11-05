import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { promoteToAdmin, seedRun } from "./seed.js";
import { EVIDENCE_DIR, openFromPalette, registerAccount, signIn } from "./support.js";

test("B — Usage shows only the account's persisted runs, with honest unknowns", async ({
  page,
  request,
}) => {
  const owner = await registerAccount(request, "usage-owner");
  const other = await registerAccount(request, "usage-other");
  promoteToAdmin(owner.id);
  seedRun(owner.id, {
    model: "claude-3-7-sonnet-20250219",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
  });
  seedRun(owner.id, { model: "model-without-known-price", inputTokens: 300, outputTokens: 100 });
  seedRun(other.id, { model: "other-account-model", inputTokens: 999_999, outputTokens: 999_999 });

  await signIn(page, owner);
  await openFromPalette(page, "Usage");

  const heading = page.getByRole("heading", { name: "Usage & Quotas" });
  await expect(heading).toBeInViewport();
  const body = page.locator("body");
  await expect(body).toContainText("claude-3-7-sonnet-20250219");
  await expect(body).toContainText("model-without-known-price");
  await expect(body).toContainText("1,300");
  await expect(body).not.toContainText("other-account-model");
  await expect(body).not.toContainText("PRIVATE-RESPONSE-TEXT");
  // The unknown model makes the total cost unknowable, and billing is never invented.
  await expect(
    page.locator(".metric", { hasText: /estimated API cost|coût API estimé/i }),
  ).toContainText(/Unavailable|Indisponible/);
  await page.screenshot({ path: `${EVIDENCE_DIR}/usage.png`, fullPage: true });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Export CSV|Exporter CSV/ }).click(),
  ]);
  const csv = readFileSync(await download.path(), "utf8");
  expect(csv).toContain("claude-3-7-sonnet-20250219");
  expect(csv).not.toContain("other-account-model");
});

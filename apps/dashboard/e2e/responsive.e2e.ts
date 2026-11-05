import { expect, test } from "@playwright/test";
import { promoteToAdmin } from "./seed.js";
import { EVIDENCE_DIR, openFromPalette, registerAccount, signIn } from "./support.js";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "laptop", width: 1280, height: 720 },
  { name: "desktop", width: 1920, height: 1080 },
];

for (const viewport of VIEWPORTS) {
  test(`H — main screens fit a ${viewport.name} (${String(viewport.width)}px)`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const admin = await registerAccount(request, `responsive-${viewport.name}`);
    promoteToAdmin(admin.id);
    await signIn(page, admin);

    const topbar = page.locator(".spatial-topbar");
    await expect(topbar).toBeVisible();

    for (const [query, heading] of [
      ["Usage", "Usage & Quotas"],
      ["Organizations", /^Organizations|^Organisations/],
      ["Observability", /^Observability|^Observabilité/],
    ] as const) {
      await openFromPalette(page, query);
      const title = page.getByRole("heading", { name: heading }).last();
      await title.scrollIntoViewIfNeeded();
      await expect(title).toBeInViewport();

      // A new window fits the screen, its title bar included, whatever came before.
      const frame = page.locator(".spatial-window").last();
      const box = await frame.boundingBox();
      expect(box).not.toBeNull();
      if (box !== null) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${EVIDENCE_DIR}/responsive-${viewport.name}.png` });
  });
}

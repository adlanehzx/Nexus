import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const API_URL = process.env.NEXUS_E2E_API_URL ?? "http://127.0.0.1:3107";
export const EVIDENCE_DIR = process.env.NEXUS_E2E_EVIDENCE_DIR ?? "/tmp/nexus-e2e-evidence";

export interface Account {
  id: string;
  email: string;
  password: string;
  accessToken: string;
}

/** Registers a real account through the public API, with a unique identity per run. */
export async function registerAccount(request: APIRequestContext, label: string): Promise<Account> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const email = `${label}-${suffix}@e2e.nexus.test`;
  const password = `e2e-${suffix}-disposable`;
  const response = await request.post(`${API_URL}/api/v1/auth/register`, {
    data: { email, password, displayName: label },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { data } = (await response.json()) as {
    data: { user: { id: string }; tokens: { accessToken: string } };
  };
  return { id: data.user.id, email, password, accessToken: data.tokens.accessToken };
}

/** Signs in through the real login form. */
export async function signIn(page: Page, account: Pick<Account, "email" | "password">) {
  await page.goto("/");
  await page.getByRole("textbox", { name: /email/i }).fill(account.email);
  await page.getByRole("textbox", { name: /password|mot de passe/i }).fill(account.password);
  await page.getByRole("button", { name: /sign in|se connecter/i }).click();
  await expect(page.locator(".spatial-minimap, .minimap, body").first()).toContainText("SPATIAL");
}

/** Opens a window the way a user does: command palette, search, Enter. */
export async function openFromPalette(page: Page, query: string) {
  await page.keyboard.press("Control+k");
  const search = page.locator(".spatial-palette-search");
  await search.fill(query);
  await search.press("Enter");
}

import { expect, test, type APIRequestContext } from "@playwright/test";
import { promoteToAdmin, sql } from "./seed.js";
import { API_URL, EVIDENCE_DIR, openFromPalette, registerAccount, signIn } from "./support.js";

function rpc(request: APIRequestContext, token: string, method: string, params: object = {}) {
  return request.post(`${API_URL}/api/v1/mcp`, {
    headers: { authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
}

test("C — a token created in the UI drives real tools, then revocation cuts it off", async ({
  page,
  request,
}) => {
  const admin = await registerAccount(request, "mcp-admin");
  promoteToAdmin(admin.id);
  await signIn(page, admin);
  await openFromPalette(page, "MCP");

  const clientName = `client-${String(Date.now())}`;
  await page.getByLabel(/Client name|Nom du client/).fill(clientName);
  await page.getByLabel("devices:read").check();
  await page.getByRole("button", { name: /Create token|Créer le token/ }).click();

  const shown = page.getByTestId("mcp-created-token");
  await expect(shown).toBeVisible();
  const token = (await shown.textContent()) ?? "";
  expect(token).toMatch(/^nxm_/);
  // Only a hash may reach the database.
  expect(sql(`SELECT count(*) FROM mcp_access_tokens WHERE "tokenHash" = '${token}';`)).toBe("0");

  const listed = await rpc(request, token, "tools/list");
  const { result: toolList } = (await listed.json()) as {
    result: { tools: { name: string }[] };
  };
  expect(toolList.tools.map((tool) => tool.name)).toEqual(["nexus_list_devices"]);

  const called = await rpc(request, token, "tools/call", {
    name: "nexus_list_devices",
    arguments: {},
  });
  const { result } = (await called.json()) as { result: { isError?: boolean } };
  expect(result.isError).toBeUndefined();

  const refused = await rpc(request, token, "tools/call", {
    name: "nexus_get_usage_metrics",
    arguments: {},
  });
  expect(JSON.stringify(await refused.json())).toContain("INSUFFICIENT_SCOPE");

  await page.getByRole("button", { name: /Refresh|Actualiser/ }).click();
  await expect(page.locator('tr[data-mcp-activity="nexus_list_devices"]').first()).toContainText(
    "success",
  );
  await expect(
    page.locator('tr[data-mcp-activity="nexus_get_usage_metrics"]').first(),
  ).toContainText("denied");
  await page.screenshot({ path: `${EVIDENCE_DIR}/mcp.png` });

  const row = page.locator(`tr[data-mcp-token="${clientName}"]`);
  await row.getByRole("button", { name: /Revoke|Révoquer/ }).click();
  await expect(row).toContainText(/Revoked|Révoqué/);
  expect((await rpc(request, token, "tools/list")).status()).toBe(401);
});

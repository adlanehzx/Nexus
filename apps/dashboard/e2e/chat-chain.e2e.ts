import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { promoteToAdmin } from "./seed.js";
import { API_URL, EVIDENCE_DIR, registerAccount, signIn } from "./support.js";

const STACK = resolve(import.meta.dirname, "../../../scripts/e2e-stack.sh");

function restartEngine(worker: boolean): void {
  execFileSync(STACK, ["restart-engine"], {
    env: { ...process.env, NEXUS_E2E_ENGINE_WORKER: worker ? "1" : "0" },
  });
}

/**
 * Everything is real except the model: the engine's worker launches the real ACP runner,
 * which speaks ACP to the repository's deterministic agent. Its registry holds no other
 * profile, so this cannot reach a provider or use any quota.
 */
test("a chat message becomes a mission, runs through ACP and answers on screen", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const admin = await registerAccount(request, "chain-admin");
  promoteToAdmin(admin.id);
  restartEngine(true);
  try {
    await signIn(page, admin);
    const composer = page.getByPlaceholder(/Assign a mission|Confiez une mission/);
    await composer.fill("Say the deterministic marker");
    await composer.press("Enter");

    await expect(page.locator("body")).toContainText("MARKER=chat-chain-e2e", {
      timeout: 150_000,
    });
    // Nothing created one, so nothing may claim one.
    await expect(page.locator("body")).not.toContainText("Checkpoint captured");
    await page.screenshot({ path: `${EVIDENCE_DIR}/chat-chain.png` });

    const response = await request.get(`${API_URL}/api/v1/dashboard/mission-control`, {
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    const { data } = (await response.json()) as { data: { missions: { state: string }[] } };
    expect(data.missions.map((mission) => mission.state)).toContain("succeeded");
  } finally {
    restartEngine(false);
  }
});

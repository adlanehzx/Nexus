import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { promoteToAdmin } from "./seed.js";
import { API_URL, EVIDENCE_DIR, registerAccount, signIn } from "./support.js";

const STACK = resolve(import.meta.dirname, "../../../scripts/e2e-stack.sh");
const STATE_DIR = process.env.NEXUS_E2E_STATE_DIR ?? "/tmp/nexus-e2e-stack";

function restartEngine(worker: string): void {
  execFileSync(STACK, ["restart-engine"], {
    env: { ...process.env, NEXUS_E2E_ENGINE_WORKER: worker },
  });
}

/**
 * The whole path with a real provider, on the account signed in to the local CLI.
 *
 * Uses that account's quota, so it runs only when asked for and after its owner approved.
 * One attempt, no quality review, a short deadline, and a workspace that is thrown away.
 */
test.skip(process.env.NEXUS_REAL_AGENT_CONVERSATION !== "1", "needs the account owner's approval");

const PROVIDERS = ["antigravity", "codex", "claude"] as const;

for (const provider of PROVIDERS) {
  test(`a chat message is answered by real ${provider}, through a mission`, async ({
    page,
    request,
  }) => {
    test.skip(
      process.env.NEXUS_REAL_AGENT_PROVIDER !== undefined &&
        process.env.NEXUS_REAL_AGENT_PROVIDER !== "all" &&
        !process.env.NEXUS_REAL_AGENT_PROVIDER.split(",")
          .map((s) => s.trim())
          .includes(provider),
      `provider ${provider} not selected in NEXUS_REAL_AGENT_PROVIDER`,
    );

    test.setTimeout(420_000);
    const admin = await registerAccount(request, `real-${provider}-admin`);
    promoteToAdmin(admin.id);
    const headers = { authorization: `Bearer ${admin.accessToken}` };
    restartEngine(provider);
    try {
      // Nothing is sent until the engine confirms it can only reach this one profile.
      await expect
        .poll(
          async () => {
            const response = await request.get(`${API_URL}/api/v1/dashboard/mission-control`, {
              headers,
            });
            const { data } = (await response.json()) as {
              data: { health: { worker_enabled: boolean; profiles: string[] } | null };
            };
            return data.health;
          },
          { timeout: 30_000 },
        )
        .toMatchObject({ worker_enabled: true, profiles: [provider] });

      await signIn(page, admin);
      const composer = page.getByPlaceholder(/Assign a mission|Confiez une mission/);
      await composer.fill("Reply with one short sentence containing the word NEXUS. Use no tools.");
      await composer.press("Enter");

      const readMissions = async () => {
        const response = await request.get(`${API_URL}/api/v1/dashboard/mission-control`, {
          headers,
        });
        const { data } = (await response.json()) as {
          data: { missions: { state: string; title: string }[] };
        };
        return data.missions;
      };
      await expect
        .poll(async () => (await readMissions())[0]?.state, {
          timeout: 400_000,
          intervals: [5_000],
        })
        .toMatch(/^(succeeded|failed|cancelled)$/);
      const [mission] = await readMissions();
      await page.screenshot({ path: `${EVIDENCE_DIR}/real-${provider}-chain.png` });
      expect(mission?.state).toBe("succeeded");

      await expect(page.locator(".chat-text").last()).toContainText("NEXUS", { timeout: 30_000 });
      await page.screenshot({ path: `${EVIDENCE_DIR}/real-${provider}-chain.png` });

      // Reported, not asserted: how much a mission does is what the owner wants to know.
      test.info().annotations.push({
        type: "workspace-entries",
        description: String(readdirSync(`${STATE_DIR}/acp-workspaces`).length),
      });
    } finally {
      restartEngine("0");
    }
  });
}

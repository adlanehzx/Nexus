import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { promoteToAdmin } from "./seed.js";
import { API_URL, EVIDENCE_DIR, openFromPalette, registerAccount, signIn } from "./support.js";

const STATE_DIR = process.env.NEXUS_E2E_STATE_DIR ?? "/tmp/nexus-e2e-stack";
const STACK = resolve(import.meta.dirname, "../../../scripts/e2e-stack.sh");

function crashEngine(): void {
  const pid = readFileSync(`${STATE_DIR}/engine.pid`, "utf8").trim();
  execFileSync("kill", ["-9", pid]);
}

test("D — a mission survives a brutal engine crash, and the screen says what is true", async ({
  page,
  request,
}) => {
  const admin = await registerAccount(request, "missions-admin");
  promoteToAdmin(admin.id);
  const headers = { authorization: `Bearer ${admin.accessToken}` };
  const name = `crash-test-${String(Date.now())}`;

  // Due now: the scheduler submits a real mission. No worker runs, so it stays queued.
  const created = await request.post(`${API_URL}/api/v1/mission-control/schedules`, {
    headers,
    data: {
      name,
      timezone: "UTC",
      run_at: new Date(Date.now() + 1_000).toISOString(),
      catch_up_policy: "latest",
      max_catch_up: 1,
      max_concurrency: 1,
      misfire_grace_seconds: 300,
      mission: {
        external_key: "dashboard-owned-server-side",
        title: name,
        workspace: "/tmp/nexus-scheduled",
        tasks: [{ key: "t", profile: "claude", instruction: "noop", depends_on: [] }],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);

  const readMissions = async () => {
    const response = await request.get(`${API_URL}/api/v1/dashboard/mission-control`, { headers });
    const { data } = (await response.json()) as {
      data: {
        reachable: boolean;
        missions: { id: string; title: string; state: string }[];
        schedules: { name: string }[];
      };
    };
    return data;
  };

  await expect
    .poll(async () => (await readMissions()).missions.filter((m) => m.title === name).length, {
      timeout: 20_000,
    })
    .toBe(1);
  const before = (await readMissions()).missions.find((m) => m.title === name);

  await signIn(page, admin);
  await openFromPalette(page, "Mission Control");
  const windowBody = page.locator(".spatial-window", { hasText: name });
  await expect(windowBody.first()).toBeVisible();

  try {
    crashEngine();

    await expect
      .poll(async () => (await readMissions()).reachable, { timeout: 15_000 })
      .toBe(false);
    await page.reload();
    await expect(page.locator(".metric", { hasText: /unreachable|inaccessible/ })).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE_DIR}/missions-engine-down.png` });
  } finally {
    execFileSync(STACK, ["restart-engine"]);
  }

  await expect.poll(async () => (await readMissions()).reachable, { timeout: 20_000 }).toBe(true);
  const after = await readMissions();
  const recovered = after.missions.find((m) => m.title === name);
  expect(recovered?.id).toBe(before?.id);
  expect(recovered?.state).toBe(before?.state);
  // Replaying the schedule must not have submitted the occurrence a second time.
  expect(after.missions.filter((m) => m.title === name)).toHaveLength(1);
  expect(after.schedules.map((schedule) => schedule.name)).toContain(name);

  await page.reload();
  await expect(page.locator(".spatial-window", { hasText: name }).first()).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE_DIR}/missions-recovered.png` });
});

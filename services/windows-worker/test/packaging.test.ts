import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDevicePolicy } from "@nexus/device-policy";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("worker Linux packaging", () => {
  it("embeds explicit and valid policy", async () => {
    const installer = await readFile(
      resolve(process.cwd(), "../../packaging/linux/install-worker.sh"),
      "utf8",
    );
    const match = /<<'POLICY'\n(?<yaml>[\s\S]*?)\nPOLICY/.exec(installer);
    expect(match?.groups?.yaml).toBeDefined();

    const directory = await mkdtemp(join(tmpdir(), "nexus-linux-policy-"));
    temporary.push(directory);
    const path = join(directory, "device-policy.yaml");
    await writeFile(path, `${match?.groups?.yaml ?? ""}\n`, { mode: 0o600 });

    const loaded = await loadDevicePolicy(path);
    expect(loaded.source).toBe("file");
    expect(loaded.policy.filesystem.allow).toEqual(["/workspace"]);
    expect(loaded.policy.exec.allowedExecutables).toEqual(["git", "node"]);
    expect(loaded.policy.network.egress).toBe("deny");
  });

  it("pins policy path in image", async () => {
    const dockerfile = await readFile(
      resolve(process.cwd(), "../../infrastructure/docker/worker.Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain("WORKER_POLICY_FILE=/var/lib/nexus/device-policy.yaml");
  });
});

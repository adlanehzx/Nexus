import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDevicePolicy } from "@nexus/device-policy";
import { POLICY_EXAMPLE, defaultPolicyPath, policyCommand } from "../src/policy.js";

describe("delivered policy example", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-cli-policy-"));
    path = join(directory, "device-policy.yaml");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reads back cleanly without errors", async () => {
    await writeFile(path, POLICY_EXAMPLE);
    const loaded = await loadDevicePolicy(path);
    expect(loaded.source).toBe("file");
  });

  it("grants zero access until edited", async () => {
    await writeFile(path, POLICY_EXAMPLE);
    const { policy } = await loadDevicePolicy(path);
    expect(policy.filesystem.allow).toEqual([]);
  });

  it("denies sensitive paths by default", async () => {
    await writeFile(path, POLICY_EXAMPLE);
    const { policy } = await loadDevicePolicy(path);
    expect(policy.filesystem.deny.under).toContain("~/.ssh");
    expect(policy.filesystem.deny.names).toContain(".env*");
    expect(policy.filesystem.deny.segments).toContain("node_modules");
    expect(policy.network.egress).toBe("deny");
    expect(policy.git.allowWrite).toBe(false);
  });

  it("init writes file and refuses overwrite without --force", async () => {
    expect(await policyCommand(["init", "--file", path])).toBe(0);
    const first = await readFile(path, "utf8");
    expect(first).toBe(POLICY_EXAMPLE);

    await writeFile(path, `${POLICY_EXAMPLE}# hand edited\n`);
    expect(await policyCommand(["init", "--file", path])).toBe(1);
    expect(await readFile(path, "utf8")).toContain("hand edited");

    expect(await policyCommand(["init", "--file", path, "--force"])).toBe(0);
    expect(await readFile(path, "utf8")).not.toContain("hand edited");
  });

  it("check returns 2 on denial, 0 on authorization", async () => {
    await writeFile(
      path,
      [
        "version: 1",
        "filesystem:",
        "  allow:",
        "    - /tmp",
        "  deny:",
        "    under:",
        "      - /tmp/forbidden",
      ].join("\n"),
    );
    expect(await policyCommand(["check", "--file", path, "--path", "/tmp/ok.txt"])).toBe(0);
    expect(await policyCommand(["check", "--file", path, "--path", "/tmp/forbidden/x"])).toBe(2);
  });

  it("check reports broken file without falling back to defaults", async () => {
    await writeFile(path, "version: 1\nfilesystem:\n  allow: [a, b\n");
    expect(await policyCommand(["check", "--file", path])).toBe(1);
  });

  it("show works even without policy file and states everything is denied", async () => {
    expect(await policyCommand(["show", "--file", join(directory, "absent.yaml")])).toBe(0);
  });

  it("rejects unknown subcommand", async () => {
    expect(await policyCommand(["delete", "--file", path])).toBe(1);
  });
});

describe("versioned template", () => {
  it("matches identical template written by init", async () => {
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const versioned = await readFile(
      join(here, "..", "..", "..", "services", "windows-worker", "device-policy.example.yaml"),
      "utf8",
    );
    expect(versioned).toBe(POLICY_EXAMPLE);
  });
});

describe("default location", () => {
  it("lives under ~/.nexus", () => {
    expect(defaultPolicyPath("/srv/nexus-user")).toBe("/srv/nexus-user/.nexus/device-policy.yaml");
  });
});

describe("nexus voice", () => {
  it("places model and voice under ~/.nexus", async () => {
    const { voicePaths } = await import("../src/voice.js");
    const paths = voicePaths("/srv/nexus-user");
    expect(paths.model).toContain("/srv/nexus-user/.nexus/models");
    expect(paths.voice).toContain("/srv/nexus-user/.nexus/voices");
    expect(paths.scratch).toBe("/srv/nexus-user/.nexus/audio-scratch");
  });

  it("rejects unknown subcommand", async () => {
    const { voiceCommand } = await import("../src/voice.js");
    expect(await voiceCommand(["speak"])).toBe(1);
  });

  it("rejects invalid dictation duration", async () => {
    const { voiceCommand } = await import("../src/voice.js");
    expect(await voiceCommand(["dictate", "--seconds", "600"])).toBe(1);
  });
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../src/profiles.js";

describe("registre ACP NEXUS", () => {
  it("charge uniquement un profil structuré et développe HOME", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-acp-"));
    const registry = join(directory, "profiles.json");
    await writeFile(
      registry,
      JSON.stringify({
        profiles: {
          claude: { command: "${HOME}/bin/claude", args: ["--cwd", "${HOME}/work"] },
        },
      }),
      { mode: 0o600 },
    );

    const profile = await loadProfile(registry, "claude");

    expect(profile.command).toMatch(/\/bin\/claude$/);
    expect(profile.args[1]).toMatch(/\/work$/);
  });

  it("refuse une clé de profil inconnue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-acp-"));
    const registry = join(directory, "profiles.json");
    await writeFile(registry, '{"profiles":{}}', { mode: 0o600 });

    await expect(loadProfile(registry, "missing")).rejects.toThrow("unknown_profile");
  });
});
